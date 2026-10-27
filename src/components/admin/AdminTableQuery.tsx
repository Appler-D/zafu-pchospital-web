"use client";

import { useEffect, useState } from "react";
import { AdminFilterDialog } from "@/components/admin/AdminFilterDialog";
import { Button } from "@/components/ui/Button";
import { adminShared } from "@/config/admin";
import { tableCopy } from "@/config/admin-tables";
import { tableField, tableSortLabel, type TableQueryOptions } from "@/config/table-queries";
import type { TableQueryState } from "@/lib/table/query-state";
import type { SortRule, TableGroupSummary } from "@/types/table";

export type TableQuickField = {
  key: string;
  label: string;
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  maxLength?: number;
};
export function AdminTableQuery<F extends Record<string, string>>({
  value,
  options,
  quick,
  onChange,
  onClear,
  summary,
  refreshing,
  onResetColumns,
  ready = true,
  problem,
}: {
  value: TableQueryState<F>;
  options: TableQueryOptions;
  quick: readonly TableQuickField[];
  onChange: (value: TableQueryState<F>) => void;
  onClear: () => void;
  summary?: TableGroupSummary;
  refreshing: boolean;
  onResetColumns?: () => void;
  ready?: boolean;
  problem?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value.fixed);
  useEffect(() => setDraft(value.fixed), [value.fixed]);
  return (
    <div className="admin-query">
      <form
        method="post"
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onChange({
            ...value,
            fixed: {
              ...value.fixed,
              ...Object.fromEntries(
                quick.map((field) => [field.key, String(data.get(field.key) ?? "").trim()]),
              ),
            },
          });
        }}
        aria-label={adminShared.filters.title}
      >
        <fieldset className="admin-filters__row admin-query__fields" disabled={!ready}>
          {quick.map((field) => (
            <label className="field" key={field.key}>
              <span className="field__label">{field.label}</span>
              {field.options ? (
                <select
                  className="field__input"
                  name={field.key}
                  value={draft[field.key] ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                >
                  <option value="">{tableCopy.all}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="field__input"
                  name={field.key}
                  value={draft[field.key] ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  maxLength={field.maxLength ?? 64}
                  placeholder={field.placeholder}
                />
              )}
            </label>
          ))}
          <Button type="submit" icon="check">
            {adminShared.filters.apply}
          </Button>
          <Button icon="filter" onClick={() => setOpen(true)}>
            {tableCopy.advanced}
          </Button>
          <Button variant="ghost" onClick={onClear}>
            {tableCopy.clear}
          </Button>
        </fieldset>
      </form>
      <div className="admin-query__chips" aria-label={tableCopy.sort}>
        {value.sort.map((rule, index) => (
          <Button
            key={rule.field}
            variant="ghost"
            aria-label={`${tableCopy.remove} ${tableSortLabel(options.id, rule.field)} ${tableCopy.sort}`}
            onClick={() => onChange({ ...value, sort: value.sort.filter((_, i) => i !== index) })}
          >
            {index + 1}. {tableSortLabel(options.id, rule.field)}{" "}
            {rule.direction === "asc" ? "↑" : "↓"} ×
          </Button>
        ))}
        {value.filters.map((rule, index) => (
          <Button
            key={`${index}:${rule.field}`}
            variant="ghost"
            onClick={() =>
              onChange({ ...value, filters: value.filters.filter((_, i) => i !== index) })
            }
          >
            {tableField(options.id, rule.field).label} {adminShared.filters.ops[rule.op]}{" "}
            {tableField(options.id, rule.field).labels?.[rule.value] ?? rule.value} ×
          </Button>
        ))}
        {value.groupBy ? (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            {tableCopy.group} · {tableField(options.id, value.groupBy).label}
          </Button>
        ) : null}
      </div>
      {open ? (
        <QueryDialog
          value={value}
          options={options}
          summary={summary}
          refreshing={refreshing}
          problem={problem}
          onChange={onChange}
          onClose={() => setOpen(false)}
          onResetColumns={onResetColumns}
        />
      ) : null}
    </div>
  );
}

function QueryDialog<F extends Record<string, string>>({
  value,
  options,
  onChange,
  onClose,
  summary,
  refreshing,
  onResetColumns,
  problem,
}: {
  value: TableQueryState<F>;
  options: TableQueryOptions;
  onChange: (value: TableQueryState<F>) => void;
  onClose: () => void;
  summary?: TableGroupSummary;
  refreshing: boolean;
  onResetColumns?: () => void;
  problem?: string;
}) {
  const [sort, setSort] = useState<SortRule[]>(value.sort);
  const [groupBy, setGroupBy] = useState(value.groupBy);
  return (
    <AdminFilterDialog
      title={tableCopy.advanced}
      fields={options.filters}
      rules={value.filters}
      onClose={onClose}
      keepOpenOnApply={Boolean(groupBy)}
      onApply={(filters) => onChange({ ...value, filters, sort, groupBy })}
    >
      <section className="admin-query__section" aria-label={tableCopy.sort}>
        <h3>{tableCopy.sort}</h3>
        <p className="admin-conditions__hint">{tableCopy.sortHint}</p>
        {sort.map((rule, index) => (
          <div className="admin-query__sortrow" key={index}>
            <label className="field">
              <span className="field__label">
                {index + 1}. {adminShared.filters.field}
              </span>
              <select
                className="field__input"
                value={rule.field}
                onChange={(event) =>
                  setSort(
                    sort.map((entry, i) =>
                      i === index ? { ...entry, field: event.target.value } : entry,
                    ),
                  )
                }
              >
                {options.sortable.map((field) => (
                  <option
                    key={field}
                    value={field}
                    disabled={field !== rule.field && sort.some((entry) => entry.field === field)}
                  >
                    {tableSortLabel(options.id, field)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{tableCopy.sort}</span>
              <select
                className="field__input"
                value={rule.direction}
                onChange={(event) =>
                  setSort(
                    sort.map((entry, i) =>
                      i === index
                        ? { ...entry, direction: event.target.value as SortRule["direction"] }
                        : entry,
                    ),
                  )
                }
              >
                <option value="asc">{tableCopy.sortAsc}</option>
                <option value="desc">{tableCopy.sortDesc}</option>
              </select>
            </label>
            <Button variant="ghost" onClick={() => setSort(sort.filter((_, i) => i !== index))}>
              {tableCopy.remove}
            </Button>
          </div>
        ))}
        <Button
          disabled={sort.length >= 3 || sort.length >= options.sortable.length}
          onClick={() => {
            const field = options.sortable.find(
              (field) => !sort.some((rule) => rule.field === field),
            );
            if (field) setSort([...sort, { field, direction: "asc" }]);
          }}
        >
          {adminShared.filters.add}
        </Button>
        {onResetColumns ? (
          <Button variant="ghost" onClick={onResetColumns}>
            {tableCopy.restoreColumns}
          </Button>
        ) : null}
      </section>
      <section className="admin-query__section" aria-label={tableCopy.group}>
        <label className="field">
          <span className="field__label">{tableCopy.group}</span>
          <select
            className="field__input"
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value)}
          >
            <option value="">{tableCopy.groupNone}</option>
            {options.groups.map((field) => (
              <option key={field} value={field}>
                {tableField(options.id, field).label}
              </option>
            ))}
          </select>
        </label>
        <p className="admin-conditions__hint">{tableCopy.groupHint}</p>
        {problem ? (
          <p className="admin-status admin-status--error" role="alert">
            {problem}
          </p>
        ) : refreshing ? (
          <p role="status">{tableCopy.updating}</p>
        ) : groupBy && summary?.field === groupBy ? (
          <dl className="admin-query__groups" aria-busy={refreshing}>
            {summary.counts.map((entry) => (
              <div key={entry.value ?? "null"}>
                <dt>
                  {entry.value === null
                    ? adminShared.none
                    : (tableField(options.id, groupBy).labels?.[entry.value] ?? entry.value)}
                </dt>
                <dd>{entry.count}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>
    </AdminFilterDialog>
  );
}
