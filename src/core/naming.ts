/**
 * Attribute <-> property name mapping (SPEC 4.1). Hyphenated segments map to
 * camelCase; a leading hyphen produces PascalCase; a name with no hyphens is
 * lowercased as a whole (so "camelCase" normalizes to "camelcase").
 */

function capitalize(segment: string): string {
  return segment.length === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1);
}

export function attributeNameToProperty(rawName: string): string {
  const leadingHyphen = rawName.startsWith("-");
  const body = (leadingHyphen ? rawName.slice(1) : rawName).toLowerCase();
  if (!body.includes("-")) {
    return leadingHyphen ? capitalize(body) : body;
  }
  const segments = body.split("-").filter((segment) => segment.length > 0);
  return segments
    .map((segment, index) => (index === 0 && !leadingHyphen ? segment : capitalize(segment)))
    .join("");
}

/**
 * Produce a candidate attribute spelling for a property name and verify it
 * round-trips through {@link attributeNameToProperty}. Returns null when the
 * property cannot be represented as an attribute (must use a JSON block).
 */
export function propertyToAttributeName(property: string): string | null {
  if (property.length === 0) return null;
  const firstUpper = /^[A-Z]/.test(property);
  let body = "";
  for (let index = 0; index < property.length; index += 1) {
    const ch = property.charAt(index);
    if (/[A-Z]/.test(ch) && index > 0) body += "-";
    body += ch.toLowerCase();
  }
  const candidate = firstUpper ? `-${body}` : body;
  return attributeNameToProperty(candidate) === property ? candidate : null;
}

/** Split a raw attribute name on literal dots into individually-normalized path segments. */
export function attributePathToPropertyPath(rawName: string): string[] {
  return rawName.split(".").map((segment) => attributeNameToProperty(segment));
}
