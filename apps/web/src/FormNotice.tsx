import { Check, X } from "lucide-react";

export type Notice = { kind: "success" | "error"; message: string } | null;

/**
 * Inline form-status strip used by every management/settings surface.
 *
 * The component must keep rendering exactly one `<div>`: `styles.css` styles
 * this strip through descendant/direct-child selectors
 * (`.settings-body>.form-status`, `.management-dialog-body .form-status`), so
 * an extra wrapper element would silently drop the sticky panel styling.
 */
export function FormNotice({ notice }: { notice: Notice }): React.ReactNode {
  if (!notice) return null;
  return (
    <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.kind === "success" ? <Check size={17} /> : <X size={17} />}
      {notice.message}
    </div>
  );
}
