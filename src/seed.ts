import type { Db } from './db.ts'
import { trace } from './trace.ts'

export const T0 = new Date('2026-11-02T09:00:00Z')
export const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

/** A fictional venue booking. All names and addresses are invented. */
export async function seed(db: Db) {
  await db.query(`
    insert into app.staff values ('u_maya','org_1','Maya Ortiz','maya@venue.example','manager'), ('u_tom','org_1','Tom Reid','tom@venue.example','coordinator');
    insert into app.bookings (id, org_id, title, event_date, guests, price_per_guest_cents, total_cents)
      values ('B-1042','org_1','Northfield team dinner','2026-11-14', 8, 10000, 80000);
    insert into app.contacts values ('C-77','org_1','B-1042','Sarah Lin','sarah@northfield.example','+44 20 0000 0001');
    insert into app.conversations values
      ('A','org_1','B-1042','email','Discount for our team dinner','external'),
      ('B','org_1','B-1042','email','Headcount for 14 November','external'),
      ('N','org_1','B-1042','note','Internal notes on B-1042','internal'),
      ('D','org_1','B-1042','email','Private room hire','external');
    insert into app.participants values
      ('A','sarah@northfield.example','Sarah Lin'),
      ('B','dev@northfield.example','Dev Patel'), ('B','sarah@northfield.example','Sarah Lin'),
      ('D','dev@northfield.example','Dev Patel');
  `)
  await trace(db, T0, 'app', 'state', 'Booking B-1042 on file', { bookingId: 'B-1042', version: 1, guests: 8, total: '£800.00', threads: ['A: Sarah Lin', 'B: Dev Patel, Sarah Lin', 'N: internal notes'] })
}
