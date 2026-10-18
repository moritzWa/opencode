"""macOS effects for the one-shot cutover. Importing this module does nothing."""
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


class Refusal(RuntimeError):
    pass


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_private(path, require_private=True):
    import stat
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise Refusal("Private input unavailable: " + str(path)) from None
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (require_private and info.st_mode & 0o077):
            raise Refusal("Expected a private current-user regular file: " + str(path))
        if info.st_size > 8 * 1024 * 1024:
            raise Refusal("Private control file exceeds size bound")
        try:
            return json.load(stream)
        except ValueError:
            raise Refusal("Invalid private JSON input: " + str(path)) from None


class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid", "nice")]
    _fields_ += [("seconds", ctypes.c_uint64), ("micros", ctypes.c_uint64)]


class Host:
    def ancestors(self):
        result = []
        pid = os.getppid()
        for _ in range(64):
            if pid <= 1:
                return result
            result.append(pid)
            output = self.capture(["/bin/ps", "-p", str(pid), "-o", "ppid="])
            pid = int(output.strip())
        raise Refusal("Process ancestry exceeded its bound")

    def cwd(self, pid):
        output = self.capture(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
        paths = [line[1:] for line in output.splitlines() if line.startswith("n/")]
        if len(paths) != 1:
            raise Refusal("Cannot resolve the old dashboard working directory")
        return paths[0]

    def now(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(seconds)

    def identity(self, pid):
        if sys.platform != "darwin":
            raise Refusal("The production controller requires macOS kernel process identity")
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        info = BsdInfo()
        size = library.proc_pidinfo(int(pid), 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size == 0:
            if ctypes.get_errno() in (0, 2, 3):
                return None
            raise Refusal("Unable to read kernel process identity")
        if size != ctypes.sizeof(info):
            raise Refusal("Unexpected PROC_PIDTBSDINFO layout")
        if info.status == 5:
            return None
        buffer = ctypes.create_string_buffer(4096)
        if library.proc_pidpath(int(pid), buffer, len(buffer)) <= 0:
            raise Refusal("Unable to resolve the running executable")
        argv = self.argv(pid)
        return {"pid": int(pid), "pgid": info.pgid, "uid": info.uid,
                "start": f"{info.seconds}.{info.micros:06}",
                "executable": os.fsdecode(buffer.value),
                "argvSha256": hashlib.sha256(argv).hexdigest()}

    def argv(self, pid):
        # Exactly KERN_PROCARGS2's argv; never inspect or dump its environment.
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, int(pid))
        size = ctypes.c_size_t(0)
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
            raise Refusal("Unable to size process argv")
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
            raise Refusal("Unable to read process argv")
        raw = buffer.raw[:size.value]
        argc = int.from_bytes(raw[:4], sys.byteorder, signed=True)
        cursor = raw.index(b"\0", 4) + 1
        while cursor < len(raw) and raw[cursor] == 0:
            cursor += 1
        result = bytearray()
        for _ in range(argc):
            end = raw.index(b"\0", cursor)
            result.extend(raw[cursor:end + 1])
            cursor = end + 1
        return bytes(result)

    def group(self, pgid):
        output = subprocess.check_output(["/bin/ps", "-axo", "pid=,pgid="], text=True, timeout=5)
        return [item for line in output.splitlines()
                if len(fields := line.split()) == 2 and int(fields[1]) == pgid
                if (item := self.identity(int(fields[0]))) is not None]

    def signal_group(self, pgid, signum):
        try:
            os.killpg(pgid, signum)
        except ProcessLookupError:
            pass

    def listener(self, pid, port):
        result = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid),
                                 f"-iTCP@127.0.0.1:{port}", "-sTCP:LISTEN", "-Fp"],
                                capture_output=True, text=True, timeout=10)
        return result.returncode == 0 and f"p{pid}" in result.stdout.splitlines()

    def writers(self, database):
        paths = [str(path) for path in (Path(database), Path(str(database) + "-wal"), Path(str(database) + "-shm")) if path.exists()]
        result = subprocess.run(["/usr/sbin/lsof", "-nP", "-F", "pfa", "--", *paths],
                                capture_output=True, text=True, timeout=10)
        if result.returncode not in (0, 1):
            raise Refusal("Cannot establish database writer inventory")
        if result.stderr.strip():
            raise Refusal("Database handle inventory is incomplete; lsof reported a warning/error")
        pid = None
        writers = set()
        for line in result.stdout.splitlines():
            if line.startswith("p"):
                pid = int(line[1:])
            if line in ("aw", "au") and pid is not None:
                writers.add(pid)
        return writers

    def port_open(self, port):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except ConnectionRefusedError:
            return False
        except OSError as error:
            raise Refusal("Cannot establish loopback endpoint closure") from error

    def free_port(self, excluded):
        for _ in range(10):
            with socket.socket() as selection:
                selection.bind(("127.0.0.1", 0))
                port = selection.getsockname()[1]
            if port not in excluded:
                return port
        raise Refusal("Cannot select a distinct loopback port")

    def api(self, record, method, path, body=None):
        url = record.get("url", f"http://127.0.0.1:{record.get('port')}")
        authorization = base64.b64encode(f"{record.get('username', 'opencode')}:{record['password']}".encode()).decode()
        request = urllib.request.Request(url.rstrip("/") + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Basic " + authorization, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            code=error.code
            error.close()
            if code == 404:
                return {"_notFound": True}
            raise Refusal(f"Native API {method} {path.split('?')[0]} returned HTTP {code}") from None
        except (OSError, ValueError):
            raise Refusal(f"Native API {method} {path.split('?')[0]} unavailable") from None

    def run(self, tag, argv, env, cwd, timeout, log):
        # Finite commands have private groups, bounded waits, and group cleanup.
        with Path(log).open("ab", buffering=0) as output:
            child = subprocess.Popen([str(arg) for arg in argv], env=env, cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                start_new_session=True, close_fds=True)
            try:
                code = child.wait(timeout=timeout)
                if code:
                    raise Refusal(f"{tag} exited {code}; private log: {log}")
            except subprocess.TimeoutExpired:
                raise Refusal(f"{tag} exceeded its finite deadline; private log: {log}") from None
            finally:
                self.finish_group(child)

    def finish_group(self, child):
        self.signal_group(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.signal_group(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
        # A helper can leave descendants after its root exits.
        self.signal_group(child.pid, signal.SIGKILL)
        deadline=self.now()+3
        while self.group(child.pid):
            if self.now()>=deadline:
                raise Refusal("Private helper group did not terminate")
            self.sleep(0.02)

    def capture(self, argv, cwd=None, env=None, timeout=10, log=None):
        with subprocess.Popen([str(arg) for arg in argv],cwd=cwd,env=env,
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                text=True,start_new_session=True,close_fds=True) as child:
            try:
                stdout,stderr=child.communicate(timeout=timeout)
                result=subprocess.CompletedProcess(argv,child.returncode,stdout,stderr)
            except subprocess.TimeoutExpired:
                raise Refusal("Read-only command deadline exceeded: " + str(argv[0])) from None
            finally:
                self.finish_group(child)
        if log:
            with Path(log).open("a") as output:
                output.write(result.stdout)
                output.write(result.stderr)
        if result.returncode:
            raise Refusal(f"Read-only command exited {result.returncode}: {argv[0]}" + (f"; private log: {log}" if log else ""))
        return result.stdout

    def start(self, argv, env, cwd, log):
        with Path(log).open("ab", buffering=0) as output:
            return subprocess.Popen([str(arg) for arg in argv], env=env, cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                start_new_session=True, close_fds=True).pid
