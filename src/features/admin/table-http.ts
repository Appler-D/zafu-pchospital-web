import { parseListQuery } from "@/lib/api/list-query";
import { parseFilters } from "@/lib/api/list-filter";
import { checkedGroup } from "@/lib/table/group-summary";
import {
  AUDIT_FILTERABLE,
  AUDIT_SORTABLE,
  INVITE_FILTERABLE,
  INVITE_SORTABLE,
  JOIN_FILTERABLE,
  JOIN_SORTABLE,
  TABLE_GROUPS,
} from "./table-fields";

const policies = {
  "join-applications": { sortable: JOIN_SORTABLE, filterable: JOIN_FILTERABLE },
  "invite-codes": { sortable: INVITE_SORTABLE, filterable: INVITE_FILTERABLE },
  audit: { sortable: AUDIT_SORTABLE, filterable: AUDIT_FILTERABLE },
};
export function tableQueryInput(params: URLSearchParams, table: keyof typeof policies) {
  const policy = policies[table];
  return {
    ...parseListQuery(params, policy),
    filters: parseFilters(params.getAll("filter"), policy.filterable),
    groupBy: checkedGroup(params.get("groupBy"), TABLE_GROUPS[table]),
  };
}
