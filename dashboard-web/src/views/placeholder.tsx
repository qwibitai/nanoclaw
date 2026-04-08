/**
 * Placeholder view used by Unit 5 for every route. Each real view
 * unit (6, 7, 8) replaces its corresponding usage with the real
 * component. Keeping a single placeholder file avoids scaffolding
 * six nearly-identical stubs that will be deleted anyway.
 */

interface PlaceholderProps {
  title: string;
  eyebrow: string;
}

export function Placeholder({ title, eyebrow }: PlaceholderProps) {
  return (
    <div className="px-6 py-8">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {eyebrow}
      </div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        Under construction. Real view lands in a later unit.
      </p>
    </div>
  );
}
