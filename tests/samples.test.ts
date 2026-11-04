import { describe, expect, it } from "vitest";
import { isCalendarDate } from "@/lib/review-contract";
import { SAMPLE_POSTERS } from "@/lib/samples";

describe("sample posters", () => {
  it("prefill ad copy only for the Dalbit Mart sample", () => {
    expect(SAMPLE_POSTERS.map((sample) => [sample.id, sample.copy])).toEqual([
      ["dalbit-camping", "Emotional Camping Must-have Item"],
      ["lumen-quest", undefined], ["bori-bakery", undefined], ["northline-shoe", undefined],
    ]);
    expect(SAMPLE_POSTERS.filter((sample) => "copy" in sample).map((sample) => sample.id)).toEqual(["dalbit-camping"]);
  });

  it("keep a valid planned date and a JPEG file for every sample", () => {
    for (const sample of SAMPLE_POSTERS) {
      expect(isCalendarDate(sample.date), sample.id).toBe(true);
      expect(sample.file, sample.id).toBe(`/samples/${sample.id}.jpg`);
    }
  });
});
