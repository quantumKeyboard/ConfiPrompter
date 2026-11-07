const crypto = require('node:crypto');

const MAX_SCRIPTS = 200;
const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 2_000_000;

function createLibrary(store) {
  function readAll() {
    const raw = store.get('scripts');
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.text === 'string'
    );
  }

  function summaries() {
    return readAll()
      .map(({ id, name, text, updatedAt }) => ({
        id,
        name,
        updatedAt: Number(updatedAt) || 0,
        words: countWords(text)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function get(id) {
    return readAll().find((item) => item.id === id) || null;
  }

  // Saving with a name that already exists overwrites that entry, so "Save"
  // on a loaded script updates it in place.
  function save(name, text) {
    const cleanName = String(name || '').trim().slice(0, MAX_NAME_LENGTH);
    if (!cleanName) {
      throw new Error('Give the script a name first.');
    }

    const cleanText = String(text || '').slice(0, MAX_TEXT_LENGTH);
    const all = readAll();
    const existing = all.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
    const now = Date.now();

    if (existing) {
      existing.name = cleanName;
      existing.text = cleanText;
      existing.updatedAt = now;
    } else {
      if (all.length >= MAX_SCRIPTS) {
        throw new Error(`Library is full (${MAX_SCRIPTS} scripts). Delete one first.`);
      }
      all.push({ id: crypto.randomUUID(), name: cleanName, text: cleanText, updatedAt: now });
    }

    store.set('scripts', all);
    return existing ? existing.id : all[all.length - 1].id;
  }

  function remove(id) {
    store.set(
      'scripts',
      readAll().filter((item) => item.id !== id)
    );
  }

  return { summaries, get, save, remove };
}

function countWords(text) {
  const matches = String(text || '').match(/[^\s#*[\]]+/g);
  return matches ? matches.length : 0;
}

module.exports = { createLibrary, countWords };
