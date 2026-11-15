import { isJsonObject, type JsonObject, type JsonValue } from '../safety/index.js';
import type { CompanionTrpc } from '../transport/index.js';

/** Connection ids that Companion never remaps to a module instance. */
const BUILT_IN_CONNECTIONS = new Set(['internal', 'bitfocus-companion']);

/** Reads the `{ fileConnectionId: actualConnectionId }` object that `importSinglePage` returns. */
export function remappingOf(value: JsonValue): Record<string, string> {
  const result: Record<string, string> = {};
  if (isJsonObject(value)) {
    for (const [key, target] of Object.entries(value)) {
      if (typeof target === 'string') result[key] = target;
    }
  }
  return result;
}

function isEntity(value: JsonObject): boolean {
  return (value['type'] === 'action' || value['type'] === 'feedback') && 'connectionId' in value;
}

function adapt(value: JsonValue, remapping: Record<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => adapt(entry, remapping));
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  const entity = isEntity(value);
  const original = entity ? value['connectionId'] : undefined;
  for (const [key, child] of Object.entries(value)) {
    if (entity && key === 'connectionId' && typeof child === 'string') {
      out[key] = remapping[child] ?? child;
    } else if (
      entity &&
      key === 'children' &&
      isJsonObject(child) &&
      Object.keys(child).length === 0 &&
      typeof original === 'string' &&
      !BUILT_IN_CONNECTIONS.has(original)
    ) {
      // Measured on 5.1.3: entities of module connections come back without an empty `children` object.
      continue;
    } else {
      out[key] = adapt(child, remapping);
    }
  }
  return out;
}

/**
 * Prepares the intended export for the read-back diff with two differences that were measured on Companion 5.1.3
 * and are not content changes: entity `connectionId`s are replaced by the ids Companion reports in the import
 * remapping, and an empty `children` object of module entities is not stored. Everything else is compared as is.
 */
export function adaptIntended(file: JsonObject, remapping: Record<string, string>): JsonObject {
  return adapt(file, remapping) as JsonObject;
}

/** Connections of the file that the import created (not in `mapping`), with the id Companion gave them. */
export function createdConnections(
  file: JsonObject,
  remapping: Record<string, string>,
  mapping: Record<string, string> | undefined,
): Array<{ fileId: string; id: string; label: string; moduleId: string }> {
  const instances = isJsonObject(file['instances']) ? file['instances'] : {};
  const created: Array<{ fileId: string; id: string; label: string; moduleId: string }> = [];
  for (const [fileId, instance] of Object.entries(instances)) {
    if (mapping !== undefined && fileId in mapping) continue;
    const id = remapping[fileId];
    if (id === undefined || !isJsonObject(instance)) continue;
    created.push({
      fileId,
      id,
      label: String(instance['label'] ?? ''),
      moduleId: String(instance['moduleId'] ?? ''),
    });
  }
  return created;
}

/** Ids of all connections that currently exist in Companion (`instances.connections.watch`, first item). */
export async function existingConnectionIds(client: CompanionTrpc): Promise<Set<string>> {
  const first = await client.firstOfSubscription('instances.connections.watch');
  const events = Array.isArray(first) ? first : [first];
  const ids = new Set<string>();
  for (const event of events) {
    if (isJsonObject(event) && event['type'] === 'init' && isJsonObject(event['info'])) {
      for (const id of Object.keys(event['info'])) ids.add(id);
    }
  }
  return ids;
}

/** Identity mapping for every connection of the file that still exists, so that a re-import reuses it. */
export function identityMapping(file: JsonObject, existing: Set<string>): Record<string, string> {
  const instances = isJsonObject(file['instances']) ? file['instances'] : {};
  const mapping: Record<string, string> = {};
  for (const id of Object.keys(instances)) {
    if (existing.has(id)) mapping[id] = id;
  }
  return mapping;
}
