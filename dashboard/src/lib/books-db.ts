import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const BOOKS_DB_PATH = path.join(
  PROJECT_ROOT,
  'container',
  'skills',
  'books',
  'books.db',
);

let _booksDb: Database.Database | null = null;

function getBooksDb(): Database.Database | null {
  if (!_booksDb) {
    if (!fs.existsSync(BOOKS_DB_PATH)) return null;
    _booksDb = new Database(BOOKS_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
  }
  return _booksDb;
}

export interface BookRow {
  title: string;
  author: string;
  type: string;
  price: string;
  order_date: string;
  asin: string;
  publisher: string;
  order_id: string;
}

export interface AuthorStat {
  author: string;
  book_count: number;
  total_spent: number;
}

export interface TypeStat {
  type: string;
  count: number;
  total_spent: number;
}

export interface YearStat {
  year: string;
  count: number;
  total_spent: number;
}

export function getTotalBooks(): number {
  const db = getBooksDb();
  if (!db) return 0;
  const row = db.prepare('SELECT COUNT(*) as count FROM books').get() as {
    count: number;
  };
  return row.count;
}

export function getTopAuthors(limit = 15): AuthorStat[] {
  const db = getBooksDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT author, COUNT(*) as book_count,
       ROUND(SUM(CAST(CASE WHEN price != '' THEN price ELSE '0' END AS REAL)), 2) as total_spent
       FROM books WHERE LENGTH(author) > 0
       GROUP BY author ORDER BY book_count DESC LIMIT ?`,
    )
    .all(limit) as AuthorStat[];
}

export function getBooksByType(): TypeStat[] {
  const db = getBooksDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT type, COUNT(*) as count,
       ROUND(SUM(CAST(CASE WHEN price != '' THEN price ELSE '0' END AS REAL)), 2) as total_spent
       FROM books WHERE LENGTH(type) > 0
       GROUP BY type ORDER BY count DESC`,
    )
    .all() as TypeStat[];
}

export function getBooksByYear(): YearStat[] {
  const db = getBooksDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT SUBSTR(order_date, 1, 4) as year, COUNT(*) as count,
       ROUND(SUM(CAST(CASE WHEN price != '' THEN price ELSE '0' END AS REAL)), 2) as total_spent
       FROM books WHERE LENGTH(order_date) > 0
       GROUP BY year ORDER BY year DESC`,
    )
    .all() as YearStat[];
}

export function getRecentBooks(limit = 20): BookRow[] {
  const db = getBooksDb();
  if (!db) return [];
  return db
    .prepare(
      'SELECT * FROM books WHERE LENGTH(order_date) > 0 ORDER BY order_date DESC LIMIT ?',
    )
    .all(limit) as BookRow[];
}

export function searchBooks(query: string, limit = 50): BookRow[] {
  const db = getBooksDb();
  if (!db) return [];
  const pattern = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM books
       WHERE title LIKE ? OR author LIKE ? OR publisher LIKE ?
       ORDER BY order_date DESC LIMIT ?`,
    )
    .all(pattern, pattern, pattern, limit) as BookRow[];
}

export function getTotalSpent(): number {
  const db = getBooksDb();
  if (!db) return 0;
  const row = db
    .prepare(
      `SELECT ROUND(SUM(CAST(CASE WHEN price != '' THEN price ELSE '0' END AS REAL)), 2) as total
       FROM books`,
    )
    .get() as { total: number };
  return row.total || 0;
}
