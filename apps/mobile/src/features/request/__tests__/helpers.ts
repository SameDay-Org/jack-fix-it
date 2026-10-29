import type { SavedAddress } from "@/features/addresses";
import type { Category } from "@/features/home/useCategories";

import type { CreatedRequest } from "../api";
import type { IntakeQuestion } from "../questions";

const both = (en: string, es: string) => ({ en, es });

/** One question of each type the API serves, as `GET /v1/categories` returns them. */
export const QUESTIONS = {
  rooms: {
    key: "rooms",
    type: "integer",
    required: true,
    labels: both("How many rooms?", "¿Cuántas habitaciones?"),
    min: 1,
    max: 6,
  },
  area: {
    key: "area",
    type: "integer",
    required: false,
    labels: both("Square feet", "Pies cuadrados"),
    min: 100,
    max: 5000,
  },
  surface: {
    key: "surface",
    type: "single_choice",
    required: true,
    labels: both("What needs painting?", "¿Qué hay que pintar?"),
    options: [
      { value: "walls", labels: both("Walls", "Paredes") },
      { value: "ceiling", labels: both("Ceiling", "Techo") },
    ],
  },
  extras: {
    key: "extras",
    type: "multi_choice",
    required: true,
    labels: both("Anything else?", "¿Algo más?"),
    options: [
      { value: "trim", labels: both("Trim", "Molduras") },
      { value: "doors", labels: both("Doors", "Puertas") },
      { value: "cabinets", labels: both("Cabinets", "Gabinetes") },
    ],
    min_selected: 1,
    max_selected: 2,
  },
  notes: {
    key: "notes",
    type: "text",
    required: false,
    labels: both("Colors you have in mind", "Colores que tienes en mente"),
    max_length: 200,
  },
  furnished: {
    key: "furnished",
    type: "boolean",
    required: false,
    labels: both("Is the room furnished?", "¿La habitación tiene muebles?"),
  },
} as const satisfies Record<string, IntakeQuestion>;

export const PAINTING: Category = {
  id: "00000000-0000-4000-8000-000000000003",
  slug: "painting",
  names: both("Painting", "Pintura"),
  icon: null,
  requires_license: false,
  intake_questions: [QUESTIONS.surface, QUESTIONS.furnished],
};

/** A category without questions: its flow starts at Describe. */
export const HANDYMAN: Category = {
  id: "00000000-0000-4000-8000-000000000002",
  slug: "handyman",
  names: both("Handyman", "Reparaciones generales"),
  icon: null,
  requires_license: false,
  intake_questions: [],
};

export const savedAddress = (patch: Partial<SavedAddress> = {}): SavedAddress => ({
  id: "10000000-0000-4000-8000-000000000001",
  label: "Home",
  line1: "12 Main St",
  line2: null,
  city: "Newark",
  state: "NJ",
  zip_code: "07102",
  lat: null,
  lng: null,
  is_default: true,
  served: true,
  ...patch,
});

export const created = (patch: Partial<CreatedRequest> = {}): CreatedRequest => ({
  id: "20000000-0000-4000-8000-000000000001",
  public_code: "JF-000124",
  status: "received",
  customer_status: "received",
  category_id: PAINTING.id,
  description: "Peeling paint in the kitchen",
  address: { line1: "12 Main St", line2: null, city: "Newark", state: "NJ", zip_code: "07102" },
  preferred_date: null,
  intake_answers: {},
  media: [],
  created_at: "2026-10-29T12:00:00Z",
  ...patch,
});
