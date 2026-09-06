"use client";

import { useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";

const CONTACT_EMAIL = "techmatrixsalesmanagment@gmail.com";

const contactFormSchema = z.object({
  name: z.string().trim().min(1, "Please enter your name"),
  email: z.string().trim().min(1, "Please enter your email").email("Please enter a valid email"),
  company: z.string().trim().optional(),
  subject: z.string().trim().optional(),
  message: z.string().trim().min(1, "Please enter a message"),
});

type ContactFormValues = z.infer<typeof contactFormSchema>;

const INITIAL_VALUES: ContactFormValues = { name: "", email: "", company: "", subject: "", message: "" };

/**
 * No backend/email service exists yet for this form, so "submitting" it
 * opens the visitor's email client with a pre-filled message to the real
 * support inbox instead of faking a server-side send — honest about what
 * actually happens rather than showing a fake "delivered" confirmation.
 */
function buildMailto(values: ContactFormValues) {
  const subject = values.subject?.trim() ? values.subject.trim() : `Website inquiry from ${values.name}`;
  const bodyLines = [
    values.company?.trim() ? `Company: ${values.company.trim()}` : null,
    `Email: ${values.email}`,
    "",
    values.message,
  ].filter((line): line is string => line !== null);

  const params = new URLSearchParams({ subject, body: bodyLines.join("\n") });
  return `mailto:${CONTACT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
}

export function ContactForm() {
  const [values, setValues] = useState<ContactFormValues>(INITIAL_VALUES);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitted, setIsSubmitted] = useState(false);
  const messageId = useId();

  function updateField<K extends keyof ContactFormValues>(field: K, value: ContactFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = contactFormSchema.safeParse(values);
    if (!result.success) {
      const errors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    window.location.href = buildMailto(result.data);
    setIsSubmitted(true);
  }

  if (isSubmitted) {
    return (
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-black/5 sm:p-10">
        <MessageBanner tone="success">
          Your email app should now be open with your message ready to send to our team. If it
          didn&apos;t open, email us directly at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline">
            {CONTACT_EMAIL}
          </a>
          .
        </MessageBanner>
        <button
          type="button"
          onClick={() => {
            setValues(INITIAL_VALUES);
            setIsSubmitted(false);
          }}
          className="mt-2 text-sm font-semibold text-sky-600 transition-colors hover:text-sky-700"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-black/5 sm:p-10"
    >
      <FormField
        label="Name"
        required
        value={values.name}
        onChange={(event) => updateField("name", event.target.value)}
        error={fieldErrors.name}
        autoComplete="name"
      />
      <FormField
        label="Email"
        type="email"
        required
        value={values.email}
        onChange={(event) => updateField("email", event.target.value)}
        error={fieldErrors.email}
        autoComplete="email"
      />
      <FormField
        label="Company"
        value={values.company}
        onChange={(event) => updateField("company", event.target.value)}
        error={fieldErrors.company}
        autoComplete="organization"
      />
      <FormField
        label="Subject"
        value={values.subject}
        onChange={(event) => updateField("subject", event.target.value)}
        error={fieldErrors.subject}
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={messageId} className="text-sm font-medium text-neutral-700">
          Message <span className="text-red-500">*</span>
        </label>
        <textarea
          id={messageId}
          rows={5}
          value={values.message}
          onChange={(event) => updateField("message", event.target.value)}
          aria-invalid={Boolean(fieldErrors.message)}
          aria-describedby={fieldErrors.message ? `${messageId}-error` : undefined}
          className={`resize-none rounded-lg border px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 ${
            fieldErrors.message ? "border-red-400 hover:border-red-400" : "border-neutral-300 hover:border-neutral-400"
          }`}
        />
        {fieldErrors.message ? (
          <p id={`${messageId}-error`} role="alert" className="text-xs text-red-600">
            {fieldErrors.message}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        className="mt-2 min-h-12 rounded-full bg-sky-600 px-8 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-sky-700"
      >
        Send Message
      </button>
    </form>
  );
}
