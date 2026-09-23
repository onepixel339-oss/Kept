import { notFound } from "next/navigation";
import {
  EntityDetailView,
  prepareConnections,
} from "@/components/exploration/entity-detail-view";
import { requirePageUser } from "@/modules/user";
import { getEntityDetail, MEMORY_PAGE_SIZE } from "@/modules/exploration";
import { findEntitiesByIds } from "@/modules/entity";
import { AppError } from "@/lib/api";
import { isTopicEntity } from "@/lib/entity-links";
import type { EntityType } from "@/types/entity";
import type { EntityDetailData } from "@/types/exploration";

/**
 * TopicDetail — one topic or project, as your memory holds it.
 *
 * A foreign or unknown id is a topic that does not exist (not an
 * error to explain); anything else falls to the error boundary with
 * its calm retry.
 */
export default async function TopicDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const userId = (await requirePageUser()).id;
  if (!userId) notFound();

  const rawPage = typeof query.page === "string" ? Number.parseInt(query.page, 10) : 1;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  let data: EntityDetailData;
  try {
    data = await getEntityDetail(userId, id, { page, pageSize: MEMORY_PAGE_SIZE });
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }

  // /topics/[id] is for topics and projects; people live on /people.
  if (!isTopicEntity(data.entity.type)) notFound();

  // Entity endpoints need their entity type to resolve the right page.
  const entityEndpointIds = [
    ...new Set(
      data.connections.flatMap((entry) => {
        const ids: string[] = [];
        if (entry.relation.sourceType === "entity") ids.push(entry.relation.sourceId);
        if (entry.relation.targetType === "entity") ids.push(entry.relation.targetId);
        return ids;
      })
    ),
  ];
  const endpointEntities = entityEndpointIds.length
    ? await findEntitiesByIds(userId, entityEndpointIds)
    : [];
  const typeById = new Map(
    endpointEntities.map((entity) => [entity.id, entity.type as EntityType])
  );

  return (
    <EntityDetailView
      data={data}
      mode="topic"
      page={page}
      connections={prepareConnections(data.entity.id, typeById, data.connections)}
    />
  );
}
