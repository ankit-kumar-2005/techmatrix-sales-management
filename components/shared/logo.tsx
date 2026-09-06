import Image from "next/image";
import Link from "next/link";

type LogoProps = {
  /** Tailwind height classes for the icon mark — defaults to the navbar's size. */
  iconClassName?: string;
  /** Set false for compact spots (e.g. beside a drawer's hamburger/close icon) that only want the mark. */
  showText?: boolean;
};

/**
 * Mark cropped from app/icon.png down to just the cloud graphic — the
 * source file is the full wide wordmark on an opaque white background,
 * which doesn't fit a small square badge, so public/techmatrix-mark.png
 * isolates just the icon portion (see public/ for the crop). Shared
 * between the navbar and the auth pages so both use the exact same
 * clean asset instead of the old boxed logo screenshot.
 */
export function Logo({ iconClassName = "h-9 w-auto sm:h-10", showText = true }: LogoProps) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <Image src="/techmatrix-mark.png" alt="Techmatrix" width={122} height={72} priority className={iconClassName} />
      {showText ? (
        <span className="flex flex-col leading-none">
          <span className="text-base font-bold text-neutral-900">Techmatrix</span>
          <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-600">
            Sales Management
          </span>
        </span>
      ) : null}
    </Link>
  );
}
