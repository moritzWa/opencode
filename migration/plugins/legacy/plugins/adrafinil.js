// @bun
// ../../../../../../../.config/opencode/plugins/adrafinil.ts
var Adrafinil = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created")
        await $`"/Applications/Adrafinil.app/Contents/Helpers/adrafinil" acquire ${event.properties.info.id} --tool opencode`;
    }
  };
};
export {
  Adrafinil
};

//# debugId=53FC0770CE70413064756E2164756E21
