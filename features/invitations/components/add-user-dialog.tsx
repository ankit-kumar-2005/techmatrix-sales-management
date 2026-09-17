"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "@/components/shared/modal";
import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { FormSection } from "@/components/shared/form-section";
import { MessageBanner } from "@/components/shared/message-banner";
import { formatRoleLabel } from "@/features/customers/lib/role-labels";
import { ContactsIcon, MailIcon, UserPlusIcon } from "@/features/sales-management/components/icons";
import { createInvitationAction } from "../actions";
import { initialInvitationFormState, type InvitationFormState } from "../form-state";
import { ManagerSelect } from "./manager-select";
import type { AssignableRole } from "../lib/get-roles";
import type { TeamDirectoryEntry } from "@/types/lead";

/** Same gradient submit button every other creation form in this app
 *  uses (LeadFormSubmitButton / ContactFormSubmitButton /
 *  TaskFormSubmitButton) — identical pending behavior, label swap
 *  instead of a bare spinner. */
function SendInvitationButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
    >
      {pending ? "Sending..." : "Send Invitation"}
    </button>
  );
}

type AddUserDialogProps = {
  roles: AssignableRole[];
  managerOptions: TeamDirectoryEntry[];
  /** Supplies the trigger that opens this dialog, given an `open`
   *  callback — the same externally-supplied-trigger convention
   *  NewContactDialog/AddTaskDialog/EditCatalogItemDialog already use,
   *  so the page header owns its own button styling. */
  renderTrigger: (open: () => void) => ReactNode;
  /** Called after the invitation row was created, with the action's OWN
   *  result. The state is passed through deliberately rather than a bare
   *  "it worked": createInvitationAction returns success together with a
   *  formError when the invitation was created but the email could not
   *  be sent (delivery unconfigured, or the provider rejected it), and
   *  the caller must be able to tell the admin that honestly instead of
   *  showing "Invitation sent successfully." over a message that never
   *  left the building. */
  onSuccess?: (state: InvitationFormState, email: string) => void;
};

/**
 * The Add User form. It does not create anything itself — it submits to
 * the existing createInvitationAction, which derives customer_id from
 * the caller's own membership, sets invited_by from the session,
 * re-validates role and manager server-side, and sends the invitation
 * email. Nothing about the tenant, the role's authority, or the
 * inviter's identity is decided here.
 *
 * Mounted only while open, so each open starts from a clean form —
 * including right after a successful send — matching every other
 * creation dialog in this app.
 */
export function AddUserDialog({ roles, managerOptions, renderTrigger, onSuccess }: AddUserDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  // Controlled purely so the success toast can name the address the
  // invitation actually went to. The Server Action still reads the
  // value from FormData like every other field — this is display
  // state, never an input to the action.
  const [email, setEmail] = useState("");
  const [state, formAction] = useActionState(createInvitationAction, initialInvitationFormState);
  const fieldErrors = state.fieldErrors ?? {};
  const formRef = useRef<HTMLFormElement>(null);

  // Close-on-success using this component's OWN isOpen state — safe to
  // adjust during render (React's documented "adjust state when a prop
  // changes" pattern), the same block NewCatalogItemDialog/
  // NewContactDialog already use and for the same reason.
  //
  // A failure deliberately leaves isOpen alone, so the dialog stays open
  // with everything the admin typed still in the fields and the error
  // shown below — nothing is retyped after a rejected duplicate email.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isOpen) {
      setIsOpen(false);
    }
  }

  // onSuccess touches the PARENT's state (the history's refresh token),
  // so it must happen in an effect rather than during this component's
  // render — same reasoning and same shape as NewContactDialog's
  // identical effect.
  useEffect(() => {
    if (state.success) {
      onSuccess?.(state, email);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSuccess intentionally excluded: a fresh closure every parent render, and re-running for that alone would re-fire it without state actually changing
  }, [state]);

  /**
   * Bring the rejected field into view after a failed submit.
   *
   * WHY THIS IS NEEDED AT ALL: this form is taller than the modal's
   * scroll area, so submitting from the bottom (where the button is)
   * leaves Full Name and Email scrolled out of sight. An inline error
   * under the Email input is the right place for it, but an error the
   * admin cannot see is no better than one shown in the wrong place —
   * the fix has to be both.
   *
   * QUERIES role="alert", NOT aria-invalid: every error renderer in this
   * form emits a role="alert" paragraph (FormField, SelectField and
   * ManagerSelect alike), whereas ManagerSelect deliberately sets no
   * aria-invalid — it is a custom combobox where that attribute isn't
   * valid on the element it would land on. One selector therefore covers
   * every control type plus the form-level banner, and because
   * querySelector returns the first match in DOM order, a field error
   * always wins over the banner (which renders last, above the footer).
   *
   * Focus moves to the offending control where there is one, so keyboard
   * and screen-reader users land on the thing to fix rather than only
   * seeing it move. preventScroll because scrollIntoView above has
   * already positioned it — letting focus() scroll again would fight it.
   */
  useEffect(() => {
    if (state.success) return;

    const hasFieldError = Object.keys(state.fieldErrors ?? {}).length > 0;
    if (!hasFieldError && !state.formError) return;

    const form = formRef.current;
    if (!form) return;

    const firstError = form.querySelector('[role="alert"]');
    if (!firstError) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    firstError.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });

    form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
  }, [state]);

  return (
    <>
      {renderTrigger(() => setIsOpen(true))}

      {isOpen ? (
        <Modal
          title="Add User"
          subtitle="Invite someone to join your organization."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
              <UserPlusIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form ref={formRef} action={formAction} className="flex flex-col gap-5">
            <FormSection icon={<ContactsIcon className="h-3.5 w-3.5" />} title="User Details">
              <FormField
                label="Full Name"
                name="full_name"
                required
                variant="filled"
                autoComplete="name"
                placeholder="e.g. Rahul Sharma"
                error={fieldErrors.full_name}
              />

              <FormField
                label="Email"
                name="email"
                type="email"
                required
                variant="filled"
                autoComplete="email"
                placeholder="name@company.com"
                icon={<MailIcon className="h-4 w-4" />}
                helperText="The invitation is sent here, and only this address can accept it."
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={fieldErrors.email}
              />
            </FormSection>

            <FormSection icon={<UserPlusIcon className="h-3.5 w-3.5" />} title="Access">
              <SelectField
                label="Role"
                id="invitation-role"
                name="role_id"
                required
                defaultValue=""
                error={fieldErrors.role_id}
              >
                <option value="" disabled>
                  Select a role
                </option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {formatRoleLabel(role.name)}
                  </option>
                ))}
              </SelectField>

              <ManagerSelect
                id="invitation-manager"
                name="manager_id"
                label="Manager"
                options={managerOptions}
                helperText="Optional. Only active members of your organization are listed."
                error={fieldErrors.manager_id}
              />
            </FormSection>

            {/* FORM-LEVEL failures ONLY, and that distinction is now
                enforced upstream: createInvitationAction routes anything
                attributable to one input into fieldErrors instead (see
                fieldForDatabaseError), so "User already exists with this
                email address" renders under the Email field and never
                reaches this banner. What is left here genuinely belongs
                to the submission rather than to a field — no permission,
                or the insert failing for a reason no input can fix — and
                sitting next to the button that was just pressed is the
                right place for that.

                The action also returns success + formError together when
                the invitation WAS created but the email could not be
                sent (delivery unconfigured, or the provider rejected
                it). The dialog closes in that case and the caller
                surfaces the honest message, hence the !state.success
                guard — this banner is only for outright failures, where
                nothing was created and the form stays open. */}
            {state.formError && !state.success ? (
              <MessageBanner tone="error">{state.formError}</MessageBanner>
            ) : null}

            <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-neutral-100 bg-white px-6 py-4">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
              <SendInvitationButton />
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
