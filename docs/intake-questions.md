# Intake questions

Each category asks the customer a few questions when they create a request (D8.3, #44). For
example, house cleaning asks for the number of bedrooms. The questions are **data**: a JSON list
in `categories.intake_questions`. Changing them needs no code change and no deploy.

- **Schema:** `app/modules/categories/intake.py` (Pydantic).
- **Read:** `GET /v1/categories` returns each category's questions, typed, under
  `intake_questions`.
- **Answer:** `POST /v1/requests` takes the answers in `intake_answers`, keyed by question.

## Who edits them

- **Now:** the seed file `apps/api/app/modules/categories/seed_data.json`. The seed inserts
  missing categories only and never updates an existing row, so a changed question reaches only
  a fresh database. An invalid question fails `load_seed_data`, and the seed writes nothing.
- **Later:** the admin panel (SQLAdmin, #41) edits the stored JSON. Stored questions are parsed
  on every read, so a bad edit cannot break the API. See
  [When stored questions do not parse](#when-stored-questions-do-not-parse).
- **Launch content** exists only for house cleaning and handyman. Painting, lawn & landscaping
  and moving & assembly ask nothing until Cesar and the partners supply their questions.
- **Copy rule:** follow the legal-copy rule in `AGENTS.md`. Questions ask; they never promise.

## Labels are data, not i18next keys

`labels` (and the optional `help`) map a locale to its text. `en` and `es` are required and must
not be blank. Other locales, such as `pt`, may be added. This is the same rule as
`categories.names`: an admin edits the copy along with the question, so it does not live in the
apps' i18next files. The Spanish copy is reviewed by a person (#93).

## The schema

Every question is an object. Unknown fields are refused, everywhere, including inside options.

| Field      | Type             | Rule                                                            |
| ---------- | ---------------- | --------------------------------------------------------------- |
| `key`      | string           | `^[a-z][a-z0-9_]{0,39}$`, unique within the category            |
| `type`     | string           | `integer`, `single_choice`, `multi_choice`, `boolean` or `text` |
| `required` | boolean          | when true, the answer must be present                           |
| `labels`   | `{locale: text}` | the question; `en` and `es` required                            |
| `help`     | `{locale: text}` | optional hint; `en` and `es` required when present              |

Each type adds its own fields.

### `integer`

`min` and `max` are integers, with `min` ≤ `max`.

```json
{
  "key": "bedrooms",
  "type": "integer",
  "required": true,
  "labels": { "en": "How many bedrooms?", "es": "¿Cuántas habitaciones?" },
  "min": 0,
  "max": 10
}
```

### `single_choice`

`options` holds 2 to 20 entries of `{value, labels}`. Each `value` follows the key pattern and
is unique within the question.

```json
{
  "key": "frequency",
  "type": "single_choice",
  "required": true,
  "labels": {
    "en": "How often do you need cleaning?",
    "es": "¿Con qué frecuencia necesitas la limpieza?"
  },
  "options": [
    { "value": "one_time", "labels": { "en": "One time", "es": "Una sola vez" } },
    { "value": "recurring", "labels": { "en": "Recurring", "es": "Recurrente" } }
  ]
}
```

### `multi_choice`

`options` follow the same rules as for `single_choice`. Two more fields bound the selection:

- `min_selected`: 0 when absent;
- `max_selected`: every option when absent.

Both must satisfy 0 ≤ `min_selected` ≤ `max_selected` ≤ the number of options.

`required` only says the answer must be present. To demand at least one choice, set
`min_selected` to 1.

```json
{
  "key": "rooms_to_paint",
  "type": "multi_choice",
  "required": true,
  "labels": { "en": "Which rooms?", "es": "¿Qué cuartos?" },
  "options": [
    { "value": "kitchen", "labels": { "en": "Kitchen", "es": "Cocina" } },
    { "value": "bedroom", "labels": { "en": "Bedroom", "es": "Dormitorio" } },
    { "value": "living_room", "labels": { "en": "Living room", "es": "Sala" } }
  ],
  "min_selected": 1,
  "max_selected": 3
}
```

### `boolean`

No extra fields.

```json
{
  "key": "has_pets",
  "type": "boolean",
  "required": false,
  "labels": { "en": "Are there pets at home?", "es": "¿Hay mascotas en casa?" },
  "help": { "en": "So the pro comes prepared.", "es": "Para que el profesional venga preparado." }
}
```

### `text`

`max_length` is from 1 to 1000 characters.

```json
{
  "key": "tasks",
  "type": "text",
  "required": true,
  "labels": {
    "en": "List every small job you need done",
    "es": "Enumera todos los trabajos pequeños que necesitas"
  },
  "max_length": 1000
}
```

The `multi_choice` and `boolean` examples only illustrate the format; they are not in the seed.

## How answers are validated

`POST /v1/requests` checks `intake_answers` before writing anything. The existing size limit
(`REQUEST_INTAKE_MAX_BYTES`) and the NUL and non-finite number checks run first.

- **With a category:**
  - every key must be one of the category's question keys;
  - every `required` question must be answered;
  - each value must fit its question:

    | Type            | A valid answer                                                                   |
    | --------------- | -------------------------------------------------------------------------------- |
    | `integer`       | an integer from `min` to `max`; not `true`/`false`, not `2.0`, not `"2"`         |
    | `single_choice` | one option `value`                                                               |
    | `multi_choice`  | a list of distinct option values, between `min_selected` and `max_selected` long |
    | `boolean`       | `true` or `false`                                                                |
    | `text`          | a string, non-empty after trimming, at most `max_length` characters              |
- **Without a category:** `intake_answers` must be `{}`. The BDC classifies the request first.
- **Stored answers** are normalized: text is trimmed.
- **On failure:** the API answers `422 invalid_intake_answers`, with one generic message that
  never says which value failed. The log `intake_answers_invalid` carries the category id, the
  keys of the category's own questions that failed, and a count of unknown keys. It never logs
  a value, and never an unknown key, because those are the customer's text.

## When stored questions do not parse

An admin edit could store questions that do not fit the schema.

- `GET /v1/categories` still lists the category, with `intake_questions: []`.
- `POST /v1/requests` with that category answers `422 invalid_category`.
- Both log `category_intake_invalid` with the category id only, never the JSON.

The customer can still send the request without a category. It then lands in the BDC queue.
