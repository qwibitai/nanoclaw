# Booking Tools

These tools let you manage appointments for the tenant you are serving.
Call them via HTTP POST to the admin API.

> **Setup**: These endpoints are served by the NestJS booking API (`claws/booking-api/`).
> Apply the `add-booking-api` skill to create it. Once running, all tools below are active.
> API is at `http://host.docker.internal:3001/api/tools/`.
> All requests require header: `x-api-key: {BOOKING_API_KEY}` (injected from env).

---

## check_availability

Find free slots for a given date and service.

```
POST http://host.docker.internal:3001/api/tools/check_availability
x-api-key: {BOOKING_API_KEY}
{
  "tenant_id": "{TENANT_ID}",
  "date": "YYYY-MM-DD",
  "service": "Tuns",
  "staff_id": "..."   // optional — omit to check all staff
}
```

Returns: list of available slots with staff names and times.

Use this **before** suggesting times to the customer. Never invent availability.

---

## create_booking

Confirm a booking after the customer agrees to a specific slot.

```
POST http://host.docker.internal:3001/api/tools/create_booking
x-api-key: {BOOKING_API_KEY}
{
  "tenant_id": "{TENANT_ID}",
  "staff_id": "...",
  "customer_phone": "...",
  "customer_name": "...",
  "service": "Tuns",
  "start_time": "2025-03-15T10:00:00"
}
```

Returns: booking confirmation with id, staff name, date and time.

Only call this after the customer has **explicitly confirmed** the slot.

---

## cancel_booking

Cancel a booking. Only succeeds if the phone matches the booking.

```
POST http://host.docker.internal:3001/api/tools/cancel_booking
x-api-key: {BOOKING_API_KEY}
{
  "booking_id": "...",
  "customer_phone": "..."
}
```

Returns: confirmation or error if phone doesn't match.

---

## get_my_bookings

Get upcoming bookings for a customer.

```
POST http://host.docker.internal:3001/api/tools/get_my_bookings
x-api-key: {BOOKING_API_KEY}
{
  "tenant_id": "{TENANT_ID}",
  "customer_phone": "..."
}
```

Returns: list of upcoming bookings (service, staff, date, time, status).

---

## Response Guidelines (Romanian)

- Always respond in Romanian
- Use natural, friendly language — not robotic
- After creating a booking, confirm: *nume, serviciu, frizier, data și ora*
- If no slots available, suggest the next available day
- Keep messages short — WhatsApp users don't read walls of text
- Example confirmation: "✅ Programarea ta a fost confirmată!\n*Serviciu:* Tuns\n*Frizier:* Andrei\n*Data:* Vineri, 15 martie, ora 10:00\nNe vedem atunci! 💈"
