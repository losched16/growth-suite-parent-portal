// Split-family pickup privacy. Pickup people are OWNED by the parent
// who added them (or whose emergency card named them). Normal families
// share the list — married co-parents both see grandma. But when the
// owner OR the viewer is a 'split'-tagged contact (separate households
// sharing a child), the other household's people are hidden: each split
// parent has their own portal and their own pickup list, period.
// Office dashboards always see everything.
//
// Interpolate with the pickup_persons alias and the $-param that holds
// the VIEWING parent's id, e.g. pickupVisibleSql('pp', '$2').

export function pickupVisibleSql(ppAlias: string, viewerParam: string): string {
  return `(
    ${ppAlias}.added_by_parent_id = ${viewerParam}::uuid
    OR NOT (
      EXISTS (SELECT 1 FROM parents po
                JOIN ghl_contact_tags spt ON spt.ghl_contact_id = po.ghl_contact_id
                                         AND spt.school_id = po.school_id
               WHERE po.id = ${ppAlias}.added_by_parent_id AND lower(spt.tag) = 'split')
      OR EXISTS (SELECT 1 FROM parents pv
                   JOIN ghl_contact_tags svt ON svt.ghl_contact_id = pv.ghl_contact_id
                                            AND svt.school_id = pv.school_id
                  WHERE pv.id = ${viewerParam}::uuid AND lower(svt.tag) = 'split')
    )
  )`;
}
