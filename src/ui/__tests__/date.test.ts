import { formatAlertTimestamp } from '../utils/date';

describe('formatAlertTimestamp', () => {
  it('formats valid timestamps in UTC', () => {
    expect(formatAlertTimestamp('2024-01-01T00:00:00Z')).toBe(
      '1/1/2024, 12:00:00 AM UTC',
    );
  });

  it('returns a fallback for invalid timestamps', () => {
    expect(formatAlertTimestamp('not-a-timestamp')).toBe('Unknown time');
  });
});
