"use client";

import { Languages } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/hooks/useTranslations";
import { useMounted } from "@/hooks/use-mounted";
import {
  getLocalizedPath,
  getPathnameWithoutLocale,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  SupportedLocale,
} from "@/lib/i18n";

export function LanguageSwitcher() {
  const mounted = useMounted();
  const { locale: currentLocale } = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  const handleLanguageChange = (newLanguage: SupportedLocale) => {
    if (newLanguage === currentLocale) return;

    // Set cookie to persist language preference
    document.cookie = `preferred-language=${newLanguage}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;

    // Get the current path without locale
    const pathnameWithoutLocale = getPathnameWithoutLocale(pathname);

    // Build the new path with the new locale using the utility function
    const newPath = getLocalizedPath(pathnameWithoutLocale, newLanguage);

    // Navigate to the new path
    router.push(newPath);
  };

  if (!mounted) {
    return (
      <Button variant="ghost" size="sm" className="gap-2" disabled suppressHydrationWarning>
        <Languages className="h-4 w-4" />
        <span>{LOCALE_NAMES[currentLocale]}</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <Languages className="h-4 w-4" />
          <span>{LOCALE_NAMES[currentLocale]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="space-y-1">
        {SUPPORTED_LOCALES.map((locale, index) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => handleLanguageChange(locale)}
            className={`${index < SUPPORTED_LOCALES.length - 1 ? "mb-1" : ""} ${currentLocale === locale ? "bg-accent" : ""}`}
          >
            {LOCALE_NAMES[locale]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
