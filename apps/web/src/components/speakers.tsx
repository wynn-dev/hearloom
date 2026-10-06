import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRoundCheck, UserRoundPlus } from "lucide-react";
import { useId, useState } from "react";
import { errorMessage, orpc } from "../lib/orpc";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field, Input, Select } from "./ui/input";
import { useToast } from "./ui/toast";

type Choice = { kind: "self" } | { kind: "person"; id: string } | { kind: "new"; name: string };

/**
 * "Who's this?" on an utterance: attribute it to me / a known person / a new person. The server
 * learns a voiceprint from the utterance audio, so future speech is recognized automatically.
 */
export function IdentifySpeaker({
  utteranceId,
  known,
  shortClip,
}: {
  utteranceId: string;
  known: boolean;
  shortClip: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>({ kind: "self" });
  const selectId = useId();
  const nameId = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const people = useQuery({ ...orpc.people.list.queryOptions(), enabled: open });
  const enroll = useMutation(
    orpc.people.enroll.mutationOptions({
      onSuccess: (res) => {
        setOpen(false);
        void queryClient.invalidateQueries({ queryKey: orpc.timeline.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.people.key() });
        toast({
          tone: "good",
          title: "Voice learned",
          description: `${res.sampleSeconds.toFixed(1)} s of audio added to the voiceprint.`,
        });
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't learn this voice", description: errorMessage(err) }),
    }),
  );

  const submit = () => {
    if (choice.kind === "self") enroll.mutate({ utteranceId, asSelf: true });
    else if (choice.kind === "person") enroll.mutate({ utteranceId, personId: choice.id });
    else if (choice.name.trim()) enroll.mutate({ utteranceId, newPersonName: choice.name.trim() });
  };

  const selectValue = choice.kind === "person" ? choice.id : choice.kind;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
        title={known ? "Change speaker" : "Who's this?"}
      >
        {known ? (
          <UserRoundCheck className="size-3" aria-hidden />
        ) : (
          <UserRoundPlus className="size-3" aria-hidden />
        )}
        {known ? "Change" : "Who's this?"}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Who is speaking?"
        description={
          shortClip
            ? "This clip is short (under 1 s), so it can't teach Hearloom the voice. Pick a longer one."
            : "Hearloom learns a voiceprint from this clip and recognizes the voice from now on."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={enroll.isPending}
              disabled={shortClip || (choice.kind === "new" && !choice.name.trim())}
              onClick={submit}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Speaker" htmlFor={selectId}>
          <Select
            id={selectId}
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              setChoice(
                v === "self"
                  ? { kind: "self" }
                  : v === "new"
                    ? { kind: "new", name: "" }
                    : { kind: "person", id: v },
              );
            }}
          >
            <option value="self">Me</option>
            {(people.data ?? [])
              .filter((p) => !p.isSelf)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            <option value="new">Someone new…</option>
          </Select>
        </Field>
        {choice.kind === "new" ? (
          <Field label="Name" htmlFor={nameId}>
            <Input
              id={nameId}
              autoFocus
              value={choice.name}
              onChange={(e) => setChoice({ kind: "new", name: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="e.g. Sam"
            />
          </Field>
        ) : null}
      </Dialog>
    </>
  );
}
