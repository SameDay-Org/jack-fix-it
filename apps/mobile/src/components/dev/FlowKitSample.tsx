// Dev-only: the kit's form pieces for multi-step flows (#45), live, on a light page. Sample strings
// are literal on purpose.
import { useState } from "react";
import { View } from "react-native";

import { Button, Chip, ChoiceCard, Input, Notice, StepProgress, Stepper } from "@/components/ui";

const JOBS = ["Lawn mowing", "Hedges and shrubs", "Yard cleanup", "Planting"];
const NOTE_MAX = 120;

export function FlowKitSample() {
  const [step, setStep] = useState(2);
  const [rooms, setRooms] = useState<number | null>(null);
  const [baths, setBaths] = useState<number | null>(null);
  const [jobs, setJobs] = useState<string[]>(["Lawn mowing"]);
  const [often, setOften] = useState<"once" | "recurring" | null>(null);
  const [note, setNote] = useState("");
  const toggle = (job: string) =>
    setJobs((picked) =>
      picked.includes(job) ? picked.filter((item) => item !== job) : [...picked, job],
    );

  return (
    <View className="gap-4 rounded-xl bg-gray-50 p-4">
      <StepProgress current={step} total={5} label={`Step ${step} of 5`} />
      <Button
        label="Next step"
        variant="secondary"
        onPress={() => setStep((current) => (current % 5) + 1)}
      />
      <Stepper label="Bedrooms" value={rooms} min={0} max={10} onChange={setRooms} />
      <Stepper label="Bathrooms" value={baths} min={1} max={10} onChange={setBaths} invalid />
      <View className="flex-row flex-wrap gap-2">
        {JOBS.map((job) => (
          <Chip
            key={job}
            label={job}
            hint="What the job covers"
            selected={jobs.includes(job)}
            disabled={jobs.length >= 3 && !jobs.includes(job)}
            onPress={() => toggle(job)}
          />
        ))}
      </View>
      <View accessibilityRole="radiogroup" className="gap-3">
        <ChoiceCard title="One time" selected={often === "once"} onPress={() => setOften("once")} />
        <ChoiceCard
          title="Recurring"
          description="Weekly or every other week"
          selected={often === "recurring"}
          onPress={() => setOften("recurring")}
        />
        <ChoiceCard
          title="Mom's"
          description="Not in our area yet."
          selected={false}
          disabled
          onPress={() => undefined}
        />
      </View>
      <Input
        label="Describe the job"
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={NOTE_MAX}
        counter={note.length >= NOTE_MAX * 0.9 ? `${note.length} / ${NOTE_MAX}` : undefined}
      />
      <Notice
        tone="danger"
        title="We're not in this area yet"
        body="Jack serves a few areas for now. Try another address."
      />
      <Notice tone="info" title="We couldn't load your saved addresses.">
        <Button label="Try again" variant="secondary" onPress={() => undefined} />
      </Notice>
    </View>
  );
}
