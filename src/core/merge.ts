import type { JsonObject, JsonValue } from "./types.ts";
import { isJsonObject } from "./types.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Mutable merge tree for building a component's props from attributes then
 * JSON blocks, in source order (SPEC 4.1). Attribute dot-paths address nested
 * properties; JSON blocks take precedence and merge objects recursively while
 * replacing arrays and scalars outright.
 */
export class PropsBuilder {
  private readonly root: Record<string, JsonValue> = {};
  private readonly assignedPaths = new Set<string>();
  readonly diagnostics: Diagnostic[] = [];

  setAttributePath(segments: readonly string[], value: JsonValue, path: string): void {
    if (segments.some((segment) => UNSAFE_KEYS.has(segment))) {
      this.diagnostics.push(
        diag("unsafeKey", path, `attribute path uses an unsafe key: ${segments.join(".")}`),
      );
      return;
    }
    const key = segments.join(".");
    if (this.assignedPaths.has(key)) {
      this.diagnostics.push(
        diag("duplicateAttribute", path, `duplicate attribute for "${key}"; first wins`),
      );
      return;
    }
    if (!this.placeAtPath(this.root, segments, value, path, "attribute")) return;
    this.assignedPaths.add(key);
  }

  mergeJsonBlock(target: readonly string[] | null, value: JsonValue, path: string): void {
    if (target && target.some((segment) => UNSAFE_KEYS.has(segment))) {
      this.diagnostics.push(
        diag("unsafeKey", path, `data-property target uses an unsafe key: ${target.join(".")}`),
      );
      return;
    }
    if (target === null) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        this.diagnostics.push(
          diag("invalidValue", path, "untargeted JSON block must be an object"),
        );
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(key)) {
          this.diagnostics.push(diag("unsafeKey", path, `JSON key is unsafe: ${key}`));
          continue;
        }
        this.root[key] = mergeValue(this.root[key], item, (bad) => this.unsafe(path, bad));
      }
      return;
    }
    const container = this.ensureObjectPath(this.root, target.slice(0, -1), path);
    if (container === null) return;
    const leaf = target[target.length - 1] as string;
    container[leaf] = mergeValue(container[leaf], value, (bad) => this.unsafe(path, bad));
  }

  private unsafe(path: string, key: string): void {
    this.diagnostics.push(diag("unsafeKey", path, `JSON key is unsafe: ${key}`));
  }

  build(): JsonObject {
    return this.root;
  }

  private placeAtPath(
    container: Record<string, JsonValue>,
    segments: readonly string[],
    value: JsonValue,
    path: string,
    kind: "attribute",
  ): boolean {
    if (segments.length === 1) {
      const key = segments[0] as string;
      const existing = container[key];
      if (
        existing !== undefined &&
        typeof existing === "object" &&
        existing !== null &&
        !Array.isArray(existing)
      ) {
        this.diagnostics.push(
          diag("ambiguousPath", path, `"${key}" is both a scalar and a parent path`),
        );
        return false;
      }
      container[key] = value;
      return true;
    }
    const [head, ...rest] = segments;
    const key = head as string;
    const existing = container[key];
    if (
      existing !== undefined &&
      (typeof existing !== "object" || existing === null || Array.isArray(existing))
    ) {
      this.diagnostics.push(
        diag("ambiguousPath", path, `"${key}" is both a scalar and a parent path`),
      );
      return false;
    }
    const next = (existing as Record<string, JsonValue> | undefined) ?? {};
    container[key] = next;
    return this.placeAtPath(next, rest, value, path, kind);
  }

  private ensureObjectPath(
    container: Record<string, JsonValue>,
    segments: readonly string[],
    path: string,
  ): Record<string, JsonValue> | null {
    let cursor = container;
    for (const segment of segments) {
      const existing = cursor[segment];
      if (
        existing !== undefined &&
        (typeof existing !== "object" || existing === null || Array.isArray(existing))
      ) {
        this.diagnostics.push(
          diag("ambiguousPath", path, `"${segment}" is both a scalar and a parent path`),
        );
        return null;
      }
      const next = (existing as Record<string, JsonValue> | undefined) ?? {};
      cursor[segment] = next;
      cursor = next;
    }
    return cursor;
  }
}

function mergeValue(
  existing: JsonValue | undefined,
  incoming: JsonValue,
  onUnsafe: (key: string) => void,
): JsonValue {
  if (!isJsonObject(existing) || !isJsonObject(incoming)) return incoming;
  const merged: Record<string, JsonValue> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (UNSAFE_KEYS.has(key)) onUnsafe(key);
    else merged[key] = mergeValue(merged[key], value, onUnsafe);
  }
  return merged;
}
