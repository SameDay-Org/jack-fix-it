// An email as the API takes it, checked the same way in the browser and in a server action
// (a server action is a public endpoint). The API's EmailStr stays the authority.

/** The longest address the API stores. */
export const EMAIL_MAX_LENGTH = 320;

// One @, something on each side, a dot in the domain, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address trimmed and lowercased (the API's NormalizedEmail), or null when it is not one. */
export function emailInput(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const email = text.trim().toLowerCase();
  return email.length <= EMAIL_MAX_LENGTH && EMAIL.test(email) ? email : null;
}
