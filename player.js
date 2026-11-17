// Точка підключення плеєра.
//
// Кнопка "Дивитись" викликає resolveStream(movie) і показує те, що функція поверне:
//
//   { type: 'video',  url: 'https://.../film.mp4' }        -> вбудований <video> (mp4/webm), прогрес зберігається
//   { type: 'iframe', url: 'https://...' }                 -> сторінка плеєра в iframe
//   null                                                   -> трейлер + легальні сервіси, де фільм доступний
//
// movie містить дані з TMDB: id, title, original_title, release_date, imdb_id, runtime тощо.
// Функція може бути async.

window.resolveStream = async function resolveStream(movie) {
  return null;
};
