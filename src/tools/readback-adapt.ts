import { isJsonObject, type JsonObject, type JsonValue } from '../safety/index.js';
import type { CompanionTrpc } from '../transport/index.js';

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
