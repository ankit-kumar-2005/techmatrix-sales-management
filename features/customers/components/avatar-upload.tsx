"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { CameraIcon, TrashIcon } from "@/features/sales-management/components/icons";

const AVATAR_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

type AvatarUploadProps = {
  userId: string;
  initialAvatarUrl: string | null;
  initial: string;
};

/**
 * No avatar storage existed anywhere in this project before this — reuses
 * the standard Supabase pattern: a public "avatars" Storage bucket
 * (see the team_directory_and_avatars migration) with per-user write
 * access enforced by path prefix, plus the existing
 * auth.users.user_metadata mechanism (already how phone/company_name are
 * carried through signup) to store the resulting public URL — no new
 * customer_users column needed.
 */
export function AvatarUpload({ userId, initialAvatarUrl, initial }: AvatarUploadProps) {
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setIsBusy(true);

    try {
      const supabase = createClient();
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
      const path = `${userId}/avatar.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, cacheControl: "3600" });

      if (uploadError) {
        setError("Couldn't upload photo. Please try again.");
        return;
      }

      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      // Cache-bust so the new photo shows immediately, not a stale
      // browser-cached image at the same public URL.
      const publicUrl = `${data.publicUrl}?v=${Date.now()}`;

      const { error: updateError } = await supabase.auth.updateUser({ data: { avatar_url: publicUrl } });
      if (updateError) {
        setError("Photo uploaded, but couldn't save it to your profile. Please try again.");
        return;
      }

      setAvatarUrl(publicUrl);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    setError(null);
    setIsBusy(true);

    try {
      const supabase = createClient();
      // Best-effort cleanup across possible extensions — clearing the
      // metadata reference below is what actually controls display, so
      // a partial/failed storage delete shouldn't block that.
      await supabase.storage
        .from("avatars")
        .remove(AVATAR_EXTENSIONS.map((extension) => `${userId}/avatar.${extension}`));

      const { error: updateError } = await supabase.auth.updateUser({ data: { avatar_url: null } });
      if (updateError) {
        setError("Couldn't remove photo. Please try again.");
        return;
      }

      setAvatarUrl(null);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <span className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sky-600 text-xl font-bold text-white">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-uploaded Storage URL, not a build-time-known image domain
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          initial
        )}
      </span>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={isBusy}
            className="flex items-center gap-1.5 rounded-full border border-neutral-300 px-3.5 py-2 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <CameraIcon className="h-3.5 w-3.5" />
            {isBusy ? "Working..." : avatarUrl ? "Replace Photo" : "Upload Photo"}
          </button>
          {avatarUrl ? (
            <button
              type="button"
              onClick={handleRemove}
              disabled={isBusy}
              className="flex items-center gap-1.5 rounded-full border border-neutral-300 px-3.5 py-2 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null}
        </div>
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
