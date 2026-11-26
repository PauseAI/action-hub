import { ChapterTransferKind } from '@/generated/prisma/enums'

type Transfer = {
  kind: ChapterTransferKind
  fromChapterId: number | null
  toChapterId: number | null
}

/**
 * Whose staff answer a chapter move (null: the holding pool, answered by global admins). A
 * member's own request, or staff sending them on, is answered by the chapter they would join;
 * staff bringing someone in is answered by the chapter they would leave.
 */
export function decidingChapter(t: Transfer): number | null {
  return t.kind === ChapterTransferKind.BRING ? t.fromChapterId : t.toChapterId
}

/** The chapter whose staff asked, for a SEND or BRING; the member's own for theirs. */
export function askingChapter(t: Transfer): number | null {
  return t.kind === ChapterTransferKind.BRING ? t.toChapterId : t.fromChapterId
}
