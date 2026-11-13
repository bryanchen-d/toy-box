import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/shared/utils";

/** One column: what it shows, and the value rows sort by. Missing values sort last. */
export type SortableColumn<Row> = {
  key: string;
  label: string;
  /** Explains what the column measures. */
  title?: string;
  sortValue: (row: Row) => number | string | null;
  render?: (row: Row) => ReactNode;
  /** Numbers read best right-aligned. */
  numeric?: boolean;
};

/** A table whose header buttons sort it; a second click reverses the order. */
export function SortableTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  initialSort,
  className,
}: {
  label: string;
  columns: readonly SortableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  initialSort: { key: string; descending: boolean };
  className?: string;
}) {
  const [sort, setSort] = useState(initialSort);
  const column = columns.find(({ key }) => key === sort.key) ?? columns[0]!;
  const sorted = [...rows].sort((left, right) => {
    const a = column.sortValue(left);
    const b = column.sortValue(right);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    const order =
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return sort.descending ? -order : order;
  });

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table aria-label={label} className="w-full text-left">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            {columns.map(({ key, label, title, numeric }) => {
              const active = key === sort.key;
              const Arrow = sort.descending ? ArrowDown : ArrowUp;
              return (
                <th
                  key={key}
                  scope="col"
                  aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
                  className={cn(
                    "px-2 py-1.5 font-medium whitespace-nowrap",
                    numeric && "text-right",
                  )}
                >
                  <button
                    type="button"
                    title={title}
                    className={cn(
                      "inline-flex items-center gap-0.5 hover:text-foreground",
                      active && "text-foreground",
                    )}
                    onClick={() =>
                      setSort(
                        active
                          ? { key, descending: !sort.descending }
                          : { key, descending: !!numeric },
                      )
                    }
                  >
                    {label}
                    {active && <Arrow aria-hidden className="size-3" />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className="border-b align-middle">
              {columns.map(({ key, sortValue, render, numeric }) => (
                <td
                  key={key}
                  className={cn(
                    "px-2 py-1.5 whitespace-nowrap",
                    numeric && "text-right tabular-nums",
                  )}
                >
                  {render ? render(row) : (sortValue(row) ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
