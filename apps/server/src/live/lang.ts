/**
 * Cheap English/Dutch guess for engines that don't report a language (local Parakeet).
 * Counts very common function words; returns null when there's too little evidence.
 */
const NL = new Set(
  "de het een en van ik je jij niet dat die is op te in met voor zijn er maar ook wat als nog wel bij naar dan heb heeft hebben was waren zo om dit deze uit kan kunnen moet moeten gaan gaat ga weet even echt nee ja jullie wij we hun hij zij ze mijn jouw onze geen al toch nu hier daar waar waarom hoe".split(
    " ",
  ),
);
const EN = new Set(
  "the a an and of i you not that this is on to in with for be are was were but also what if still well at so it he she they we my your our no yes have has had do does did can could should would will just really here there where why how about from".split(
    " ",
  ),
);

export function guessLanguage(text: string): "en" | "nl" | null {
  const words = text.toLowerCase().match(/[a-zàâäéèêëïîôöùûüÿç']+/g) ?? [];
  let nl = 0;
  let en = 0;
  for (const w of words) {
    if (NL.has(w)) nl++;
    if (EN.has(w)) en++;
  }
  if (nl + en < 2) return null;
  if (nl > en * 1.2) return "nl";
  if (en > nl * 1.2) return "en";
  return null;
}
