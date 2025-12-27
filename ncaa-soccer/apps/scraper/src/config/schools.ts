
export interface SchoolConfig {
    name: string;
    baseUrl: string;
    scheduleApiUrl: string; // The specific JSON endpoint we identified
}

export const accSchools: SchoolConfig[] = [
    {
        name: 'SMU',
        baseUrl: 'https://smumustangs.com',
        scheduleApiUrl: 'https://smumustangs.com/services/adaptive_components.ashx?type=results&sport_id=8&count=50'
    },
    {
        name: 'Clemson',
        baseUrl: 'https://clemsontigers.com',
        scheduleApiUrl: 'https://clemsontigers.com/services/adaptive_components.ashx?type=results&sport_id=8&count=50'
    },
    {
        name: 'UNC',
        baseUrl: 'https://goheels.com',
        scheduleApiUrl: 'https://goheels.com/services/adaptive_components.ashx?type=results&sport_id=8&count=50'
    },
    {
        name: 'Virginia',
        baseUrl: 'https://virginiasports.com',
        scheduleApiUrl: 'https://virginiasports.com/services/adaptive_components.ashx?type=results&sport_id=8&count=50'
    },
    {
        name: 'Duke',
        baseUrl: 'https://goduke.com',
        scheduleApiUrl: 'https://goduke.com/services/adaptive_components.ashx?type=results&sport_id=8&count=50'
    }
];
