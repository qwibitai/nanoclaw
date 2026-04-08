/**
 * Meal Plan view.
 *
 * Days stacked vertically on mobile, two-column grid above md. No
 * checkboxes (read-only). Empty state is plain centered text.
 */

import { useQuery } from "@tanstack/react-query";
import { ApiError, fetchMeals } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type {
  Ingredients,
  IngredientsSection,
  Meal,
  MealDay,
  MealPlan,
} from "@/types";

export function MealsView() {
  const query = useQuery({
    queryKey: queryKeys.meals,
    queryFn: fetchMeals,
  });

  return (
    <div className="px-5 py-6 md:px-8 md:py-8">
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          This week
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Meal Plan</h1>
      </div>

      {query.isPending && <MealsSkeleton />}
      {query.isError && <ErrorCard error={query.error} onRetry={() => query.refetch()} />}

      {query.data && !query.data.plan && !query.data.ingredients && (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No current meal plan.
        </div>
      )}

      {query.data?.plan && <PlanSection plan={query.data.plan} />}
      {query.data?.ingredients && (
        <IngredientsList ingredients={query.data.ingredients} />
      )}
    </div>
  );
}

function PlanSection({ plan }: { plan: MealPlan }) {
  return (
    <section className="mb-8">
      {(plan.title || plan.subtitle) && (
        <header className="mb-4">
          {plan.title && (
            <h2 className="text-[1.125rem] font-semibold tracking-tight">
              {plan.title}
            </h2>
          )}
          {plan.subtitle && (
            <p className="mt-1 text-sm text-muted-foreground">{plan.subtitle}</p>
          )}
        </header>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {plan.days.map((day) => (
          <DayCard key={day.name} day={day} />
        ))}
      </div>
    </section>
  );
}

function DayCard({ day }: { day: MealDay }) {
  return (
    <div
      className="rounded-[var(--radius)] border border-border bg-card px-4 py-4"
      data-testid="meal-day"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {day.name}
      </div>
      <div className="mt-2 flex flex-col gap-3">
        {day.meals.map((meal, i) => (
          <MealRow key={`${day.name}-${i}`} meal={meal} />
        ))}
      </div>
    </div>
  );
}

function MealRow({ meal }: { meal: Meal }) {
  return (
    <div>
      <div className="text-[0.9375rem] font-medium leading-snug">
        <span className="text-muted-foreground">{meal.label}:</span>{" "}
        <span>{meal.desc}</span>
      </div>
      {meal.details.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
          {meal.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {meal.recipes.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
          {meal.recipes.map((r, i) => (
            <a
              key={i}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-primary underline underline-offset-2"
            >
              {r.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function IngredientsList({ ingredients }: { ingredients: Ingredients }) {
  return (
    <section>
      <header className="mb-3">
        <h2 className="text-[1.125rem] font-semibold tracking-tight">
          {ingredients.title || "Ingredients"}
        </h2>
      </header>
      <div className="flex flex-col gap-5">
        {ingredients.sections.map((section, i) => (
          <IngredientsSectionView key={i} section={section} />
        ))}
      </div>
    </section>
  );
}

function IngredientsSectionView({ section }: { section: IngredientsSection }) {
  return (
    <div data-testid="ingredients-section">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {section.name}
      </div>
      <ul className="mt-1.5 flex flex-col gap-0.5 text-[0.9375rem]">
        {section.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function MealsSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-[var(--radius)] border border-border bg-card px-4 py-4"
        >
          <div className="h-3 w-16 rounded-sm bg-muted/70" />
          <div className="mt-3 space-y-2">
            <div className="h-4 w-3/4 rounded-sm bg-muted" />
            <div className="h-4 w-2/3 rounded-sm bg-muted/80" />
            <div className="h-4 w-4/5 rounded-sm bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorCard({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.status} ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "Unknown error";

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-4 py-4">
      <div className="text-sm font-medium">Couldn't load meal plan.</div>
      <div className="mt-1 text-xs text-muted-foreground">{message}</div>
      <button
        onClick={onRetry}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
      >
        Retry
      </button>
    </div>
  );
}
