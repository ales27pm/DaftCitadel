export const formatAlertTimestamp = (timestamp: string): string => {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return 'Unknown time';
  }
  return `${value.toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
};
