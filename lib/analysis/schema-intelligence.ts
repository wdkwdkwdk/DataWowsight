import { randomUUID } from "crypto";
import { saveSchemaEntities, upsertKnowledgeTerm } from "../memory-db";
import { introspectDatasource } from "../target-db/introspection";
import type { SchemaEntity } from "../types";

export async function runSchemaIntelligence(
  datasourceId: string,
  uri: string,
  options?: { maxTables?: number },
) {
  const entities = await introspectDatasource(datasourceId, uri, options);
  const sanitized = entities.filter((entity) => typeof entity.tableName === "string" && entity.tableName.trim().length > 0);
  const enriched = await enrichEntityDescriptions(sanitized);
  await saveSchemaEntities(enriched);

  for (const entity of enriched) {
    await upsertKnowledgeTerm({
      id: randomUUID(),
      term: entity.tableName,
      definition: entity.description ?? `${entity.tableName} table`,
      scope: datasourceId,
      confidence: 0.6,
      source: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }); // 扫描阶段只写表级术语，字段级术语延后按需写入以控制耗时
  }

  return enriched;
}

async function enrichEntityDescriptions(entities: SchemaEntity[]) {
  return entities.map((entity) => {
    const tableDesc = heuristicTableDescription(entity.tableName, entity.columns.length);
    return {
      ...entity,
      description: tableDesc,
      columns: entity.columns.map((c) => ({
        ...c,
        description: `${c.name} 字段，类型 ${c.dataType}`,
      })),
    };
  });
}

function heuristicTableDescription(tableName: string, columnCount: number) {
  return `${tableName} 表，包含 ${columnCount} 个字段，用于记录业务数据。`;
}
