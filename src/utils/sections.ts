import type { Section } from '../api/youtube';

export function stableOrderSections(sections: Section[]): Section[] {
  const seen = new Set<string>();
  return sections.filter((section) => {
    const key = section.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
