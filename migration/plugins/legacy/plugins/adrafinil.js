// @bun
// ../../../../../../../.config/opencode/plugins/adrafinil.ts
var adrafinil = "/Applications/Adrafinil.app/Contents/Helpers/adrafinil";
var Adrafinil = async ({ $ }) => {
  const held = new Set;
  const release = async (id) => {
    if (!held.delete(id))
      return;
    await $`${adrafinil} release ${id} --tool opencode`.quiet().nothrow();
  };
  return {
    event: async ({ event }) => {
      if (event.type === "session.deleted")
        return release(event.properties.info.id);
      if (event.type !== "session.status")
        return;
      const id = event.properties.sessionID;
      const status = event.properties.status.type;
      if (status === "idle")
        return release(id);
      if (status !== "busy" || held.has(id))
        return;
      held.add(id);
      await $`${adrafinil} acquire ${id} --tool opencode --ttl 14400`.quiet().nothrow();
    }
  };
};
export {
  Adrafinil
};

//# debugId=A62D492DD77679D664756E2164756E21
