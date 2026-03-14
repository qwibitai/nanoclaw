# Booking Tools

These tools let you manage appointments for the tenant you are serving.
Call them via HTTP POST to the admin API.

> **TODO**: The HTTP endpoint below is added by the `add-admin-panel` skill.
> Until that skill is applied, use the booking-db functions directly in the seed script.
> The API will be available at `http://host.docker.internal:3001/api/tools/`.

---

## check_availability

Find free slots for a given date and service.

```
POST http://host.docker.internal:3001/api/tools/check_availability
{
  "tenant_id": "...",
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
{
  "tenant_id": "...",
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
{
  "tenant_id": "...",
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
