// ReadAlong Constants
// This file contains all configuration constants

export const SPEEDS = [0.75, 0.80, 0.85, 0.90, 0.95, 1.0, 1.1, 1.25, 1.5, 2.0];
export const EPUB_CACHE_VERSION = 9;

// Default settings
export const DEFAULT_FONT_SIZE = 21;
export const DEFAULT_READ_SIZE = 21;
export const DEFAULT_SPEED_IDX = 5;
export const DEFAULT_MODE = 'reading';
export const DEFAULT_THEME = 'dark';
export const DEFAULT_API_PROVIDER = 'deepseek';
export const DEFAULT_DENSITY = 'regular';
export const DEFAULT_RADIUS = 14;
export const DEFAULT_ANIM_DUR = 560;

// Accent palette (from proto — key = display name, value = hex or null for auto)
export const ACCENTS = {
  'auto':     null,
  'Бурштин':  '#f4a73f',
  'Оксамит':  '#9c3b2c',
  'Індиго':   '#6366f1',
  'Смарагд':  '#2f9e6f',
  'Троянда':  '#e86a8a',
};

// Density → --pad-x values (px)
export const PADS = { compact: 52, regular: 74, comfy: 104 };

// Walking animation easing curves
export const WALK_CURVES = {
  spring: 'cubic-bezier(0.34,1.2,0.64,1)',
  smooth: 'cubic-bezier(0.22,1,0.36,1)',
  linear: 'linear',
};

// LocalStorage keys
export const STORAGE_KEYS = {
  SERVER: 'st_server',
  TOKEN: 'st_token',
  API_KEY: 'st_apikey',
  API_PROVIDER: 'st_apiprovider',
  FONT_SIZE: 'st_fontsize',
  READ_SIZE: 'st_readsize',
  SPEED: 'st_speed',
  MODE: 'st_mode',
  THEME: 'st_theme',
  FONT_FAMILY: 'st_fontfamily',
  ACCENT: 'st_accent',
  FOLDERS_EXPANDED: 'st_folders',
  VIEW_MODE: 'st_viewmode',
  DENSITY: 'st_density',
  RADIUS: 'st_radius',
  ANIM_DUR: 'st_animdur',
};

// API endpoints template
export const API_ENDPOINTS = {
  TOKEN: '/api/v2/token',
  BOOKS: '/api/v2/books',
  BOOK_COVER: (bookId) => `/api/v2/books/${bookId}/cover`,
  BOOK_SYNCED: (bookId) => `/api/books/${bookId}/synced`,
  LISTEN_MANIFEST: (bookId) => `/api/v2/books/${bookId}/listen/manifest.json`,
  LISTEN_AUDIO: (bookId, href) => `/api/v2/books/${bookId}/listen/${encodeURIComponent(href)}`
};

// Timeout for fetch requests
export const FETCH_TIMEOUT = 30000;

// Cache settings
export const CACHE_SETTINGS = {
  EPUB: 'epubs',
  AUDIO: 'audio',
  DB_NAME: 'ReadAlongCache',
  DB_VERSION: 2
};
