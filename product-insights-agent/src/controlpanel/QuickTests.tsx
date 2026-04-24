"use client";

interface Props {
  productId: string;
}

export function QuickTests({ productId }: Props) {
  const links: { href: string; label: string }[] = [
    {
      href: `/api/seed-questions?productId=${encodeURIComponent(productId)}`,
      label: "View seed questions JSON →",
    },
    { href: "/api/health", label: "View /api/health →" },
    { href: "/widget/widget.js", label: "View widget bundle →" },
    { href: "/widget/widget.css", label: "View widget styles →" },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow-md">
      <h2 className="mb-3 font-semibold text-zinc-900">Quick Tests</h2>
      <div className="space-y-2">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-sm text-blue-600 hover:underline"
          >
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}
