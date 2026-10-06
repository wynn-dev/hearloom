import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AudioLines, Contact, Trash2 } from "lucide-react";
import { useState } from "react";
import { RelTime } from "../../components/bits";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
import { useTimeZone } from "../../lib/me";
import { errorMessage, orpc } from "../../lib/orpc";
import { useNow } from "../../lib/time";

export const Route = createFileRoute("/_app/people")({
  component: PeoplePage,
});

const th = "px-3 py-2 font-medium first:pl-4 last:pr-4";
const td = "px-3 py-2.5 first:pl-4 last:pr-4";

function PeoplePage() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const queryClient = useQueryClient();
  const toast = useToast();
  const people = useQuery(orpc.people.list.queryOptions());
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.people.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.timeline.key() });
  };
  const save = useMutation(
    orpc.people.save.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        refresh();
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't save", description: errorMessage(err) }),
    }),
  );
  const remove = useMutation(
    orpc.people.remove.mutationOptions({
      onSuccess: () => {
        refresh();
        toast({
          tone: "good",
          title: "Person removed",
          description: "Their voiceprints were deleted.",
        });
      },
    }),
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Voices Hearloom recognizes. Teach it a voice with “Who's this?” next to any line in the timeline."
      />
      <Card>
        <CardHeader icon={<Contact aria-hidden />} title="Known voices" />
        {people.error ? (
          <ErrorNotice error={people.error} onRetry={() => void people.refetch()} className="m-4" />
        ) : people.isLoading ? (
          <LoadingRows />
        ) : (people.data ?? []).length === 0 ? (
          <EmptyState icon={<AudioLines aria-hidden />} title="No voices yet">
            Open the timeline, hover a line of speech and choose “Who's this?”. Start with your own
            voice.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line text-xs text-ink-3">
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Voiceprints</th>
                  <th className={th}>Lines heard</th>
                  <th className={th}>Last heard</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {people.data!.map((p) => (
                  <tr key={p.id}>
                    <td className={td}>
                      {editing?.id === p.id ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (editing.name.trim())
                              save.mutate({ id: p.id, name: editing.name.trim() });
                          }}
                        >
                          <Input
                            autoFocus
                            value={editing.name}
                            onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                            className="h-7 w-48"
                          />
                          <Button
                            size="sm"
                            variant="primary"
                            type="submit"
                            loading={save.isPending}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="font-medium hover:underline"
                          onClick={() => setEditing({ id: p.id, name: p.name })}
                          title="Rename"
                        >
                          {p.name}
                        </button>
                      )}
                      {p.isSelf ? (
                        <Badge tone="accent" className="ml-2">
                          me
                        </Badge>
                      ) : null}
                    </td>
                    <td className={`${td} tabular`}>{p.voiceprints}</td>
                    <td className={`${td} tabular`}>{p.utterances}</td>
                    <td className={td}>
                      {p.lastHeardAt ? <RelTime date={p.lastHeardAt} now={now} tz={tz} /> : "—"}
                    </td>
                    <td className={`${td} text-right`}>
                      <div className="flex justify-end gap-1">
                        {!p.isSelf ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => save.mutate({ id: p.id, name: p.name, isSelf: true })}
                          >
                            This is me
                          </Button>
                        ) : null}
                        <ConfirmButton
                          title={`Remove ${p.name}?`}
                          description="Their voiceprints are deleted. Past lines stay in the timeline but lose the name."
                          confirmLabel="Remove"
                          onConfirm={() => remove.mutateAsync({ id: p.id })}
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${p.name}`}
                        >
                          <Trash2 aria-hidden />
                        </ConfirmButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
