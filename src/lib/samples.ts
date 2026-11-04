// Sample posters supplied for NARAK by the project owner, with invented brands. A sample only
// fills the setup form through the normal upload checks. Its review is a live review like any
// other, and no result is stored with it.
export interface SamplePoster {
  id: string;
  file: string;
  thumb: string;
  name: string;
  brand: string;
  title: string;
  date: string;
  // Ad copy that the sample fills into the visible copy field, where the user can edit it.
  copy?: string;
}

const sample = (id: string, brand: string, title: string, date: string, copy?: string): SamplePoster => ({
  id, file: `/samples/${id}.jpg`, thumb: `/samples/${id}-thumb.webp`, name: `${id}.jpg`, brand, title, date, ...(copy === undefined ? {} : { copy }),
});

export const SAMPLE_POSTERS: readonly SamplePoster[] = [
  sample("dalbit-camping", "Dalbit Mart", "Camping essentials", "2026-12-01", "Emotional Camping Must-have Item"),
  sample("lumen-quest", "Lumen Quest", "New character update", "2026-12-01"),
  sample("bori-bakery", "Bori Bakery", "Bread baked today", "2026-12-08"),
  sample("northline-shoe", "Northline", "Run Your City", "2026-12-08"),
];
