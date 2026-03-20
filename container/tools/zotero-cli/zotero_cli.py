#!/usr/bin/env python3
"""Zotero CLI — read/write access to Zotero library via Web API."""

import argparse
import json
import os
import sys
from pyzotero import zotero


def get_client():
    """Create Zotero client from environment variables."""
    api_key = os.environ.get('ZOTERO_API_KEY')
    library_id = os.environ.get('ZOTERO_LIBRARY_ID')
    if not api_key or not library_id:
        print("Error: ZOTERO_API_KEY and ZOTERO_LIBRARY_ID must be set", file=sys.stderr)
        sys.exit(1)
    return zotero.Zotero(library_id, 'user', api_key)


def find_collection_key(zot, name):
    """Find collection key by name (case-insensitive)."""
    for col in zot.collections():
        if col['data']['name'].lower() == name.lower():
            return col['key']
    return None


def cmd_search(args):
    """Search library for items matching query."""
    zot = get_client()
    items = zot.items(q=args.query, limit=args.limit)
    results = [{
        'key': item['key'],
        'title': item['data'].get('title', ''),
        'creators': [c.get('lastName', c.get('name', '')) for c in item['data'].get('creators', [])],
        'date': item['data'].get('date', ''),
        'itemType': item['data'].get('itemType', ''),
        'DOI': item['data'].get('DOI', ''),
        'url': item['data'].get('url', ''),
        'extra': item['data'].get('extra', ''),
    } for item in items]
    output(results, args.format)


def cmd_add(args):
    """Add a new item to the library, optionally to a collection."""
    zot = get_client()
    creators = []
    if args.authors:
        for author in args.authors.split(';'):
            parts = author.strip().rsplit(' ', 1)
            if len(parts) == 2:
                creators.append({'creatorType': 'author', 'firstName': parts[0], 'lastName': parts[1]})
            else:
                creators.append({'creatorType': 'author', 'name': parts[0]})

    item = {
        'itemType': args.type or 'journalArticle',
        'title': args.title,
        'creators': creators,
    }
    if args.doi:
        item['DOI'] = args.doi
    if args.url:
        item['url'] = args.url
    if args.note:
        item['extra'] = args.note

    collection_key = None
    if args.collection:
        collection_key = find_collection_key(zot, args.collection)
        if not collection_key:
            # Create collection if it doesn't exist
            resp = zot.create_collection([{'name': args.collection}])
            collection_key = resp['successful']['0']['data']['key']
        item['collections'] = [collection_key]

    resp = zot.create_items([item])
    created = resp['successful']['0']
    result = {'key': created['data']['key'], 'title': args.title, 'collection': args.collection}
    output(result, args.format)


def cmd_list(args):
    """List items in a collection."""
    zot = get_client()
    col_key = find_collection_key(zot, args.collection)
    if not col_key:
        print(f"Error: Collection '{args.collection}' not found", file=sys.stderr)
        sys.exit(1)
    items = zot.collection_items(col_key, limit=args.limit)
    results = [{
        'key': item['key'],
        'title': item['data'].get('title', ''),
        'creators': [c.get('lastName', c.get('name', '')) for c in item['data'].get('creators', [])],
        'date': item['data'].get('date', ''),
        'DOI': item['data'].get('DOI', ''),
        'extra': item['data'].get('extra', ''),
    } for item in items if item['data'].get('itemType') != 'attachment']
    output(results, args.format)


def cmd_add_to(args):
    """Add an existing item to a collection."""
    zot = get_client()
    col_key = find_collection_key(zot, args.collection)
    if not col_key:
        print(f"Error: Collection '{args.collection}' not found", file=sys.stderr)
        sys.exit(1)
    item = zot.item(args.item_key)
    collections = item['data'].get('collections', [])
    if col_key not in collections:
        collections.append(col_key)
        item['data']['collections'] = collections
        zot.update_item(item)
    result = {'key': args.item_key, 'collection': args.collection, 'action': 'added'}
    output(result, args.format)


def cmd_remove(args):
    """Remove an item from a collection."""
    zot = get_client()
    col_key = find_collection_key(zot, args.collection)
    if not col_key:
        print(f"Error: Collection '{args.collection}' not found", file=sys.stderr)
        sys.exit(1)
    item = zot.item(args.item_key)
    collections = item['data'].get('collections', [])
    if col_key in collections:
        collections.remove(col_key)
        item['data']['collections'] = collections
        zot.update_item(item)
    result = {'key': args.item_key, 'collection': args.collection, 'action': 'removed'}
    output(result, args.format)


def cmd_collections(args):
    """List all collections."""
    zot = get_client()
    cols = zot.collections()
    results = [{'key': c['key'], 'name': c['data']['name'], 'numItems': c['meta'].get('numItems', 0)} for c in cols]
    output(results, args.format)


def output(data, fmt):
    """Output data as JSON or text."""
    if fmt == 'text':
        if isinstance(data, list):
            for item in data:
                if 'title' in item:
                    creators = ', '.join(item.get('creators', []))
                    print(f"[{item['key']}] {item['title']} — {creators}")
                elif 'name' in item:
                    print(f"[{item['key']}] {item['name']} ({item.get('numItems', 0)} items)")
        elif isinstance(data, dict):
            for k, v in data.items():
                print(f"{k}: {v}")
    else:
        print(json.dumps(data, indent=2))


def main():
    parser = argparse.ArgumentParser(prog='zotero-cli', description='Zotero CLI for NanoClaw agents')
    parser.add_argument('--format', choices=['json', 'text'], default='json')
    sub = parser.add_subparsers(dest='command', required=True)

    # search
    p = sub.add_parser('search', help='Search library')
    p.add_argument('query')
    p.add_argument('--limit', type=int, default=10)
    p.set_defaults(func=cmd_search)

    # add
    p = sub.add_parser('add', help='Add item to library')
    p.add_argument('--title', required=True)
    p.add_argument('--authors', default='')
    p.add_argument('--doi', default='')
    p.add_argument('--url', default='')
    p.add_argument('--note', default='')
    p.add_argument('--type', default='journalArticle')
    p.add_argument('--collection', default='')
    p.set_defaults(func=cmd_add)

    # list
    p = sub.add_parser('list', help='List items in a collection')
    p.add_argument('collection')
    p.add_argument('--limit', type=int, default=25)
    p.set_defaults(func=cmd_list)

    # add-to
    p = sub.add_parser('add-to', help='Add item to a collection')
    p.add_argument('item_key')
    p.add_argument('collection')
    p.set_defaults(func=cmd_add_to)

    # remove
    p = sub.add_parser('remove', help='Remove item from a collection')
    p.add_argument('item_key')
    p.add_argument('collection')
    p.set_defaults(func=cmd_remove)

    # collections
    p = sub.add_parser('collections', help='List collections')
    p.set_defaults(func=cmd_collections)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
