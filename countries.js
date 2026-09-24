/*
 * Static country list (name + ISO 3166-1 alpha-2 code), used to:
 *   1. Populate the country dropdown in the search bar.
 *   2. Scope Nominatim city suggestions to that country (countrycodes param).
 * Kept as a static file instead of a live lookup so the dropdown is instant
 * and never depends on a third country-data API being up.
 */
const COUNTRIES = [
  ["Anywhere", ""],
  ["Jamaica", "jm"], ["United States", "us"], ["United Kingdom", "gb"], ["Canada", "ca"],
  ["Mexico", "mx"], ["Brazil", "br"], ["Argentina", "ar"], ["Colombia", "co"], ["Peru", "pe"],
  ["Chile", "cl"], ["Cuba", "cu"], ["Dominican Republic", "do"], ["Bahamas", "bs"], ["Barbados", "bb"],
  ["Trinidad and Tobago", "tt"], ["Haiti", "ht"], ["Belize", "bz"], ["Costa Rica", "cr"], ["Panama", "pa"],
  ["France", "fr"], ["Spain", "es"], ["Portugal", "pt"], ["Italy", "it"], ["Germany", "de"],
  ["Netherlands", "nl"], ["Belgium", "be"], ["Switzerland", "ch"], ["Austria", "at"], ["Greece", "gr"],
  ["Ireland", "ie"], ["Iceland", "is"], ["Norway", "no"], ["Sweden", "se"], ["Denmark", "dk"],
  ["Finland", "fi"], ["Poland", "pl"], ["Czechia", "cz"], ["Hungary", "hu"], ["Croatia", "hr"],
  ["Turkey", "tr"], ["Morocco", "ma"], ["Egypt", "eg"], ["South Africa", "za"], ["Kenya", "ke"],
  ["Nigeria", "ng"], ["Ghana", "gh"], ["Tanzania", "tz"], ["Ethiopia", "et"], ["Senegal", "sn"],
  ["Japan", "jp"], ["South Korea", "kr"], ["China", "cn"], ["Thailand", "th"], ["Vietnam", "vn"],
  ["Indonesia", "id"], ["Philippines", "ph"], ["Malaysia", "my"], ["Singapore", "sg"], ["India", "in"],
  ["United Arab Emirates", "ae"], ["Israel", "il"], ["Jordan", "jo"], ["Qatar", "qa"], ["Saudi Arabia", "sa"],
  ["Australia", "au"], ["New Zealand", "nz"], ["Fiji", "fj"],
  ["Peru", "pe"], ["Ecuador", "ec"], ["Bolivia", "bo"], ["Uruguay", "uy"], ["Paraguay", "py"],
  ["Guyana", "gy"], ["Suriname", "sr"], ["Venezuela", "ve"],
  ["Iceland", "is"], ["Malta", "mt"], ["Cyprus", "cy"], ["Slovenia", "si"], ["Slovakia", "sk"],
  ["Romania", "ro"], ["Bulgaria", "bg"], ["Serbia", "rs"], ["Montenegro", "me"], ["Albania", "al"],
  ["Estonia", "ee"], ["Latvia", "lv"], ["Lithuania", "lt"], ["Luxembourg", "lu"], ["Monaco", "mc"],
];

// Dedupe (a couple of entries above are intentionally repeated regions, drop repeats).
const seenCC = new Set();
const COUNTRY_LIST = COUNTRIES.filter(([name, code]) => {
  const key = name + code;
  if (seenCC.has(key)) return false;
  seenCC.add(key);
  return true;
}).sort((a, b) => {
  if (a[1] === "") return -1;
  if (b[1] === "") return 1;
  return a[0].localeCompare(b[0]);
});
