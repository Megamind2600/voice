/**
 * sharelink.test.tsx — the "copy link to this search" button and its URL contract.
 *
 * The link only has value if it is honest: disabled until there is an origin to encode, and the
 * thing copied is the thing that would reload — the fragment, not some other URL. These tests
 * also pin that the address bar is synchronised, because a copied link that is correct while the
 * bar is wrong means the next refresh loses the search.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Container, ContainerKind } from '../src/lib/binary';
import { StationIndex } from '../src/lib/stations';
import { buildStationsContainer } from './helpers';
import { CopyPlanLink, shareUrl } from '../src/ui/CopyPlanLink';
import type { PlanInput } from '../src/state/useJourneys';

function stations(): StationIndex {
  const buf = buildStationsContainer([
    { code: 'NDLS', name: 'New Delhi', rank: 3, calls: 500 },
    { code: 'BCT', name: 'Mumbai Central', rank: 3, calls: 400 },
  ]);
  return StationIndex.fromContainer(Container.parse(buf, ContainerKind.Stations));
}

const IDX = stations();
const at = (code: string) => IDX.at(IDX.indexOfCode(code));

const PLAN: PlanInput = {
  origin: at('NDLS'),
  date: '2026-09-14',
  timeMin: 510,
  destination: at('BCT'),
  maxTransfers: 2,
  preferredClass: 'SL',
  returnDate: null,
  daysAtDestination: null,
};

describe('shareUrl', () => {
  it('is null without an origin', () => {
    expect(shareUrl({ ...PLAN, origin: null })).toBeNull();
  });

  it('is the current page with the plan fragment appended', () => {
    const url = shareUrl(PLAN);
    expect(url).toContain('#v1:o=NDLS');
    expect(url).toContain('d=BCT');
    expect(url).toContain('date=2026-09-14');
  });
});

describe('CopyPlanLink', () => {
  it('is disabled until an origin is chosen', () => {
    render(<CopyPlanLink plan={{ ...PLAN, origin: null }} />);
    const btn = screen.getByRole('button', { name: /copy link/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('copies the fragment and keeps the address bar in step', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    render(<CopyPlanLink plan={PLAN} />);
    await user.click(screen.getByRole('button', { name: /copy link/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('#v1:o=NDLS');
    expect(replace).toHaveBeenCalled();
    const args = replace.mock.calls[0] as unknown[];
    expect(String(args[2])).toContain('#v1:o=NDLS');
    expect((await screen.findByRole('status')).textContent).toMatch(/copied/i);
    replace.mockRestore();
  });
});
