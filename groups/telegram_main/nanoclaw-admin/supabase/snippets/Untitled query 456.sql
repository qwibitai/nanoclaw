CREATE OR REPLACE VIEW public.vw_recent_prices AS
SELECT
  ip.itinerary_id,
  ip.saildate,
  ip.price_inside,
  ip.price_oceanview,
  ip.price_balcony,
  ip.price_suite,
  ip.check_prices_url,
  ip.created_at,
  ip.is_latest
FROM public.itinerary_prices ip
WHERE
  ip.saildate > NOW()
  AND ip.created_at >= NOW() - INTERVAL '3 months';

CREATE OR REPLACE VIEW public.vw_latest_prices_unpivot AS
SELECT
  rp.itinerary_id,
  cabin_prices.cabin_type,
  cabin_prices.latest_price,
  rp.check_prices_url,
  rp.created_at AS price_created_at
FROM public.vw_recent_prices rp
CROSS JOIN LATERAL (
  VALUES
    ('inside',    rp.price_inside),
    ('oceanview', rp.price_oceanview),
    ('balcony',   rp.price_balcony),
    ('suite',     rp.price_suite)
) AS cabin_prices(cabin_type, latest_price)
WHERE
  rp.is_latest = true
  AND rp.created_at > NOW() - INTERVAL '3 days'
  AND cabin_prices.latest_price IS NOT NULL;

CREATE OR REPLACE VIEW public.vw_average_prices_unpivot AS
SELECT
  rp.itinerary_id,
  cabin_prices.cabin_type,
  AVG(cabin_prices.price)    AS average_price,
  STDDEV(cabin_prices.price) AS stddev_price
FROM public.vw_recent_prices rp
CROSS JOIN LATERAL (
  VALUES
    ('inside',    rp.price_inside),
    ('oceanview', rp.price_oceanview),
    ('balcony',   rp.price_balcony),
    ('suite',     rp.price_suite)
) AS cabin_prices(cabin_type, price)
WHERE cabin_prices.price IS NOT NULL
GROUP BY rp.itinerary_id, cabin_prices.cabin_type;

CREATE OR REPLACE VIEW public.vw_price_drops AS
SELECT
  lp.itinerary_id,
  lp.cabin_type,
  lp.latest_price,
  lp.check_prices_url,
  lp.price_created_at,
  ap.average_price,
  ((ap.average_price - lp.latest_price) / ap.average_price * 100) AS price_drop_percentage
FROM public.vw_latest_prices_unpivot lp
INNER JOIN public.vw_average_prices_unpivot ap
  ON lp.itinerary_id = ap.itinerary_id
  AND lp.cabin_type = ap.cabin_type
WHERE lp.latest_price < ap.average_price;

create or replace function refresh_itinerary_price_drops()
  returns table(
    itinerary_id character varying,
    cabin_type text,
    average_price double precision,
    price_drop_percentage double precision,
    price_created_at timestamp with time zone,
    cruiseline_id uuid,
    ship_id uuid,
    saildate timestamp with time zone,
    latest_price double precision,
    latest_price_per_night double precision,
    check_prices_url text
  )
  as $$
    begin
      return query
      SELECT
        pd.itinerary_id,
        pd.cabin_type,
        pd.average_price,
        pd.price_drop_percentage,
        pd.price_created_at,
        i.cruiseline_id,
        i.ship_id,
        i.saildate,
        pd.latest_price,
        pd.latest_price / i.nights as latest_price_per_night,
        pd.check_prices_url
      FROM public.vw_price_drops pd
      INNER JOIN public.itineraries i ON pd.itinerary_id = i.id
      ORDER BY pd.price_drop_percentage DESC;
    end;
  $$ language plpgsql SECURITY DEFINER;