import Image from "next/image";
import Link from "next/link";
import { BRAND_MARK_HEIGHT, BRAND_MARK_SRC, BRAND_MARK_WIDTH, BRAND_NAME } from "@/lib/brand";

type LogoProps = {
  /** Tailwind height classes for the icon mark — defaults to the navbar's size. */
  iconClassName?: string;
  /** Set false for compact spots (e.g. beside a drawer's hamburger/close icon) that only want the mark. */
  showText?: boolean;
};

/**
 * The product's own mark + wordmark. Shared between the navbar and the
 * auth pages so both use the exact same asset and the same brand name,
 * read from lib/brand.ts rather than hardcoded here a second time.
 */
export function Logo({ iconClassName = "h-9 w-auto sm:h-10", showText = true }: LogoProps) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <Image
        src={BRAND_MARK_SRC}
        alt={BRAND_NAME}
        width={BRAND_MARK_WIDTH}
        height={BRAND_MARK_HEIGHT}
        priority
        className={iconClassName}
      />
      {showText ? <span className="text-base font-bold text-neutral-900">{BRAND_NAME}</span> : null}
    </Link>
  );
}
