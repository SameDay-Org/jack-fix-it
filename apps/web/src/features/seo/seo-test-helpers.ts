import type { Category, Region } from "./catalog";

/** The API's catalog as tests serve it: shaped like the shipped seed, trimmed. */
export const CLEANING: Category = {
  id: "0b6c1a52-1111-4222-8333-944455556601",
  slug: "house-cleaning",
  names: { en: "House Cleaning", es: "Limpieza del hogar" },
  icon: null,
  requires_license: false,
  intake_questions: [
    {
      type: "integer",
      key: "bedrooms",
      required: true,
      labels: { en: "How many bedrooms?", es: "¿Cuántas habitaciones?" },
      min: 0,
      max: 20,
    },
    {
      type: "single_choice",
      key: "frequency",
      required: true,
      labels: {
        en: "How often do you need cleaning?",
        es: "¿Con qué frecuencia necesitas la limpieza?",
      },
      options: [
        { value: "one_time", labels: { en: "One time", es: "Una sola vez" } },
        {
          value: "recurring",
          labels: { en: "Recurring", es: "Recurrente" },
          description: { en: "Weekly or every other week", es: "Cada semana o cada dos" },
        },
      ],
    },
  ],
};

export const PAINTING: Category = {
  id: "0b6c1a52-1111-4222-8333-944455556602",
  slug: "painting",
  names: { en: "Painting", es: "Pintura" },
  icon: null,
  requires_license: true,
  intake_questions: [
    {
      type: "multi_choice",
      key: "jobs",
      required: true,
      labels: { en: "Which jobs do you need?", es: "¿Qué trabajos necesitas?" },
      options: [
        {
          value: "interior",
          labels: { en: "Interior painting", es: "Pintura interior" },
          description: {
            en: "Walls in one or more rooms",
            es: "Paredes de una o más habitaciones",
          },
        },
        { value: "cabinets", labels: { en: "Cabinets", es: "Gabinetes" } },
      ],
      min_selected: 1,
    },
  ],
};

/** A category added in the database after launch: no copy of its own, no questions. */
export const POOLS: Category = {
  id: "0b6c1a52-1111-4222-8333-944455556603",
  slug: "pool-care",
  names: { en: "Pool Care", es: "Cuidado de piscinas" },
  icon: null,
  requires_license: false,
  intake_questions: [],
};

export const SOUTH_FLORIDA: Region = {
  region: "South Florida",
  cities: [
    {
      city: "Fort Lauderdale",
      state: "FL",
      zips: [
        { id: "5b1f0c1e-2222-4333-8444-655566667701", zip_code: "33301" },
        { id: "5b1f0c1e-2222-4333-8444-655566667702", zip_code: "33304" },
      ],
    },
    {
      city: "Hollywood",
      state: "FL",
      zips: [{ id: "5b1f0c1e-2222-4333-8444-655566667703", zip_code: "33019" }],
    },
  ],
};

export const TREASURE_COAST: Region = {
  region: "Treasure Coast",
  cities: [
    {
      city: "Stuart",
      state: "FL",
      zips: [{ id: "5b1f0c1e-2222-4333-8444-655566667704", zip_code: "34994" }],
    },
  ],
};

/** A fetch that answers the two catalog routes, recording what each call asked for. */
export function catalogFetch(
  categories: Category[] | (() => Response),
  regions: Region[] | (() => Response),
  calls: { path: string; init: RequestInit | undefined }[] = [],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const answer = (body: unknown) => (typeof body === "function" ? body() : Response.json(body));
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, init });
    if (path === "/v1/categories") return answer(categories);
    if (path === "/v1/service-areas") return answer(regions);
    throw new Error(`unexpected fetch ${path}`);
  };
}
