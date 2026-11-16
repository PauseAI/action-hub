import { useEffect } from 'react'

/**
 * Titles the tab after data only the signed-in viewer may see, which server metadata must
 * not reveal. Follows the root layout's `Action Hub | %s` template; does nothing until `title`
 * is known.
 */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `Action Hub | ${title}`
  }, [title])
}
