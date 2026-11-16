# Module catalog

The catalog is offline data about Bitfocus Companion modules: which actions and feedbacks a module
offers and what their options look like. It is used to validate configuration before it is written
to Companion and to help find the right module for a device.

**Important:** the data comes from reading module source code (and, for the `internal` module, the
Companion 5.1.3 source). It was **not tested against devices** and **not tested against a running
Companion instance**. Treat it as a well-sourced reference, not as ground truth. Every entry
carries a file and line so the claim can be checked.

## Layout

```
src/catalog/
  types.ts          zod schemas and TypeScript types
  index.ts          lookup and validation API
  data/
    _index.json     all known modules (kind full or index-only), devices without a module
    <moduleId>.json one file per catalogued module
test/catalog/       schema, consistency, lookup and validation tests
```

`index.ts` imports the JSON files statically (`with { type: 'json' }`). TypeScript copies them to
`dist/catalog/data/` during `npm run build`, so no extra copy step is needed. Data is parsed with
zod lazily, on first access.

## Public API (`src/catalog/index.ts`)

| Function                                           | Purpose                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `listModules()`                                    | All modules of the index (about 100), with repo, version, base library, kind            |
| `searchModules(query)`                             | Case-insensitive AND search over id, repo, manufacturer, products, keywords             |
| `getModule(id)`                                    | Full data of a catalogued module, `undefined` for index-only or unknown modules         |
| `findAction(moduleId, actionId)`                   | One action definition                                                                   |
| `findFeedback(moduleId, feedbackId)`               | One feedback definition                                                                 |
| `validateActionOptions(moduleId, actionId, opts)`  | `Issue[]` for options in the Companion 5 format `{ optionId: { isExpression, value } }` |
| `validateFeedbackOptions(moduleId, feedbackId, o)` | Same for feedbacks                                                                      |
| `supportsExpressions(module, entity?)`             | Whether option values may be expressions (see below)                                    |
| `listNoModule()`, `listUnusable()`                 | Devices without a module (with generic alternatives), repositories that cannot be used  |

An `Issue` is `{ path, code, message }`. Codes: `unknown-module`, `unknown-action`,
`unknown-feedback`, `unknown-option`, `missing-option`, `invalid-option-shape`, `invalid-type`,
`invalid-value`, `out-of-range`, `pattern-mismatch`, `expression-not-supported`,
`expression-not-allowed`.

## Data model

### Module file

`moduleId`, `name`, `repo` (`owner/name`), `version` (package.json of the inspected commit),
`baseVersion` (`@companion-module/base` range), `lastCommit` (date) and `lastCommitSha`, `status`,
`coverage`, optional `optionsSupportExpressions`, `actions`, `feedbacks`, `notes`.

### Actions and feedbacks

`id` (the key the module registers), `name`, `options`, `provenance` (`file`, `line` relative to the
repository root), and optionally `description`, `availability` (for example "only for firmware 4
and 5"), `optionsComplete`, `optionsSupportExpressions`, and for feedbacks `feedbackType`
(`boolean`, `advanced`, `value`).

### Options

`id`, `type` (`dropdown`, `number`, `textinput`, `checkbox`, `colorpicker`, `multidropdown`, or
`other` with the original Companion type in `rawType`, for example `internal:page`), `label`,
`default`, and the constraints below.

- `choices` is a **closed list**: the module defines exactly these ids. Ids keep their source type;
  `1` and `'1'` are different values (the Videohub and ATEM pickers use numbers, many others use
  strings). An empty list means the module fills the list at runtime and is not treated as closed.
- `choicesNote` describes lists that depend on the device or model (inputs of a switcher, timelines
  of a show). Such options are validated only through `valueType`, `min`, `max`, `integer` and
  `valuePattern`. For example the Videohub ports are `valueType: number`, `min: 1`, because the
  module offers 1-based ids.
- `min`, `max`, `step`, `integer` come from the number field. `useVariables` marks text inputs
  that resolve `$(...)`; numeric text inputs are not range-checked when a variable is present.
- `allowInvalidValues` (module source): values outside the list are accepted. The validator then
  only applies the declared value shape.
- `disableAutoExpression` (module source): the field cannot be switched to expression mode.
- `visibleWhen`, `regex` are informational (the source condition and the source regular
  expression). They are not evaluated.
- `optionsComplete: false` on an action means the option list is built at runtime (for example
  `layer<ScreenId>` options of the Analog Way modules). Unknown options are then not reported.

### Expression support

Companion 5.1.3 lets option values be expressions only for modules on the new child handler, that
is `@companion-module/base` 2.x (`ApiVersions.ts` `doesModuleUseNewChildHandler`; `HostContext.ts`
sets `optionsSupportExpressions: true`, `ChildHandlerLegacy.ts` sets `false`). The catalog derives
module support from the major version of `baseVersion`. Internal Companion actions declare the flag
per definition; the catalog stores it per entry. The validator reports:

- `expression-not-supported` for an expression on a module or entry without expression support;
- `expression-not-allowed` for an expression on an option with `disableAutoExpression`.

### Required options

An option is required when the source marks it `required`, or when it is a dropdown, number or
multi-select without a default that is always shown. Options with a default are never reported as
missing because Companion fills the default.

## Verification statuses

| Status            | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `verified-sample` | Extracted from the source and at least five entries compared with the source by hand  |
| `read`            | Extracted from the source, not hand-compared (or compared on fewer than five entries) |
| `unverified`      | Taken from research notes only, source not read                                       |

`coverage` is `complete` when the list holds every action and feedback found in the source, and
`partial` when only the most important ones are catalogued (the module `notes` say which). A
status says how the data was gathered, never that a device accepts the values.

## How the data was produced

The JSON files were generated by a static extractor that parses the module source with the
TypeScript compiler API (no module code is executed) and resolves constants, shared option
helpers and spreads. Dynamic parts that cannot be known offline became `choicesNote`. Hand-written
patches fix things the extractor cannot see (runtime-built options). The generator scripts are not
part of this repository; the committed JSON is the source of truth and may be edited by hand.
Files are formatted with Prettier (`npx prettier --write src/catalog`).

### Differences between modules worth knowing

- Several modules use inconsistent id types in their own source (for example a numeric default
  with string choice ids in `panasonic-ptz` `insPosition`, `colorBarsType` and the vMix feedback
  `dynamic`). The catalog records the source as written; `test/catalog/schema.test.ts` lists these
  known cases.
- ATEM `dskAuto` uses the option id `downstreamKeyerId`; the other DSK actions use `key`.
- Option ids for the same concept differ between action and feedback (Videohub feedbacks use
  `output`, the actions use `destination`).
- ATEM and several others hide the M/E or DSK picker on single-M/E or single-DSK models and ignore
  its value.

## Adding a module

1. Clone the module and note the commit date, package.json version and the
   `@companion-module/base` range.
2. Read the action and feedback definitions. Record `id`, `name`, options with defaults, choices,
   limits and the file and line of every definition. Keep source behavior: do not "fix" odd
   defaults, record them.
3. Write `src/catalog/data/<moduleId>.json` following `types.ts`. The file name must equal
   `moduleId`. Choose `coverage` and `status` honestly and describe gaps in `notes`.
4. Import the JSON in `src/catalog/index.ts` and add it to `RAW_MODULES`.
5. Add or update the module in `data/_index.json` with `kind: "full"` (version, base version and
   commit date must match the module file).
6. Run `npx prettier --write src/catalog test/catalog`, `npx tsc --noEmit` and
   `npx vitest run test/catalog`. The consistency tests check schema, unique ids, provenance, that
   the index and the loader agree, and that no new default/choice type mismatch appears.
7. Compare at least five entries with the source by hand before setting `verified-sample`.

## Index file

`_index.json` lists every module found in the surveyed repositories (module id from the manifest,
repository, version, base library range, date of the last commit, manufacturer, products,
keywords), a `noModule` section with devices that have no module and the generic modules that can
replace them (`generic-osc`, `generic-tcp-udp`, `generic-http`, `generic-pjlink`; the list stays empty, with an explaining note, when no alternative was verified), and `unusable`
repositories (for example modules whose manifest id is still the template placeholder). Legacy
repositories without a manifest are listed with the directory name as id and a note.
