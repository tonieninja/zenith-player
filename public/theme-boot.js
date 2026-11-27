// jasny motyw ustawiony przed pierwszym malowaniem, inaczej przy starcie mignęłoby ciemne tło
(function () {
  try {
    var m = localStorage.getItem('zenith_appearance');
    if (m === 'light' || (m === 'system' && matchMedia('(prefers-color-scheme: light)').matches))
      document.documentElement.dataset.theme = 'light';
  } catch {
    /* bez dostępu do localStorage zostaje ciemny */
  }
})();
