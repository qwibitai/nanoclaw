select
  itinerary_id,
  saildate,
  price_inside,
  price_oceanview,
  price_balcony,
  price_suite,
  check_prices_url,
  created_at,
  is_latest
from
  itinerary_prices ip
where
  saildate > now()
  and created_at >= (now() - '3 mons'::interval);