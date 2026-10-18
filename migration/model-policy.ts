import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

const Options = Schema.Struct({
  exclude: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})

// V2 deliberately ignores V1 provider.blacklist. Keep the user's exact
// exclusions in a public registry transform without removing internal title
// providers such as Groq from the runtime catalog.
export default Plugin.define({
  id: "moritz.model-policy",
  async setup(ctx) {
    const options = Schema.decodeUnknownSync(Options)(ctx.options)
    await ctx.model.transform((editor) => {
      editor.list().forEach((model) => {
        if (options.exclude[model.providerID]?.includes(model.id)) editor.remove(model.providerID, model.id)
      })
    })
  },
})
