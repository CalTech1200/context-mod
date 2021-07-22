import {Rule, RuleJSONConfig, RuleOptions, RuleResult} from "./index";
import {Comment} from "snoowrap";
import Submission from "snoowrap/dist/objects/Submission";
import {
    comparisonTextOp, FAIL, isExternalUrlSubmission, parseGenericValueComparison,
    parseGenericValueOrPercentComparison, parseRegex,
    PASS
} from "../util";
import {
    ActivityWindowType, JoinOperands,
} from "../Common/interfaces";
import dayjs from 'dayjs';

export interface RegexCriteria {
    /**
     * A descriptive name that will be used in logging and be available for templating
     *
     * @examples ["swear words"]
     * */
    name?: string
    /**
     * A valid Regular Expression to test content against
     *
     * Do not wrap expression in forward slashes
     *
     * EX For the expression `/reddit|FoxxMD/` use the value should be `reddit|FoxxMD`
     *
     * @examples ["reddit|FoxxMD"]
     * */
    regex: string,
    /**
     * Regex flags to use
     * */
    regexFlags?: string,

    /**
     * Which content from an Activity to test the regex against
     *
     * Only used if the Activity being tested is a Submission -- Comments are only tested against their content (duh)
     *
     * @default ["title", "body"]
     * */
    testOn?: ('title' | 'body' | 'url')[]

    /**
     * **When used with `window`** determines what type of Activities to retrieve
     *
     * @default "all"
     * */
    lookAt?: 'submissions' | 'comments' | 'all',

    /**
     * A string containing a comparison operator and a value to determine when an Activity is determined "matched"
     *
     * The syntax is `(< OR > OR <= OR >=) <number>`
     *
     * * EX `> 7  => greater than 7 matches found in the Activity, Activity is matched
     * * EX `<= 3` => less than 3 matches found in the Activity, Activity is matched
     *
     * @pattern ^\s*(>|>=|<|<=)\s*(\d+)(\s+.*)*$
     * @default "> 0"
     * @examples ["> 0"]
     * */
    matchThreshold?: string,

    /**
     * An string containing a comparison operator and a value to determine how many Activities need to be "matched" (based on `matchThreshold` condition) to trigger the rule
     *
     * **Only useful when used in conjunction with `window`**. If no `window` is specified only the Activity being checked is tested (so the default should/will be used).
     *
     * To disable (you are only using `totalMatchThreshold`) set to `null`
     *
     * The syntax is `(< OR > OR <= OR >=) <number>[percent sign]`
     *
     * * EX `> 3`  => greater than 3 Activities met the `matchThreshold` condition, Rule is triggered
     * * EX `<= 10%` => less than 10% of all Activities retrieved from `window` met the `matchThreshold` condition, Rule is triggered
     *
     * @pattern ^\s*(>|>=|<|<=)\s*(\d+)\s*(%?)(.*)$
     * @default "> 0"
     * @examples ["> 0"]
     * */
    activityMatchThreshold?: string,

    /**
     * A string containing a comparison operator and a value to determine how many total matches satisfies the criteria.
     *
     * If both this and `activityMatchThreshold` are present then whichever is satisfied first will be used.
     *
     * If not using `window` then this should not be used as running `matchThreshold` on one Activity is effectively the same behavior ( but I'm not gonna stop ya ¯\\\_(ツ)\_/¯ )
     *
     * The syntax is `(< OR > OR <= OR >=) <number>`
     *
     * * EX `> 7`  => greater than 7 matches found in Activity + Author history `window`
     * * EX `<= 3` => less than 3 matches found in the Activity + Author history `window`
     *
     * @pattern ^\s*(>|>=|<|<=)\s*(\d+)(\s+.*)*$
     * @default "null"
     * @examples ["> 0"]
     * */
    totalMatchThreshold?: string,

    window?: ActivityWindowType
}

export class RegexRule extends Rule {
    criteria: RegexCriteria[];
    condition: JoinOperands;

    constructor(options: RegexRuleOptions) {
        super(options);
        const {
            criteria = [],
            condition = 'OR'
        } = options || {};
        if (criteria.length < 1) {
            throw new Error('Must provide at least one RegexCriteria');
        }
        this.criteria = criteria;
        this.condition = condition;
    }

    getKind(): string {
        return 'Regex';
    }

    getSpecificPremise(): object {
        return {
            criteria: this.criteria,
            condition: this.condition,
        }
    }

    protected async process(item: Submission | Comment): Promise<[boolean, RuleResult]> {

        let criteriaResults = [];

        for (const criteria of this.criteria) {

            const {
                name,
                regex,
                regexFlags,
                testOn: testOnVals = ['title', 'body'],
                lookAt = 'all',
                matchThreshold = '> 0',
                activityMatchThreshold = '> 0',
                totalMatchThreshold = null,
                window,
            } = criteria;

            // normalize their values and also ensure we don't have duplicates
            const testOn = testOnVals.map(y => y.toLowerCase()).reduce((acc: string[], curr) => {
                if (acc.includes(curr)) {
                    return acc;
                }
                return acc.concat(curr);
            }, []);

            // check regex
            const reg = new RegExp(regex);
            // ok cool its a valid regex

            const matchComparison = parseGenericValueComparison(matchThreshold);
            const activityMatchComparison = activityMatchThreshold === null ? undefined : parseGenericValueOrPercentComparison(activityMatchThreshold);
            const totalMatchComparison = totalMatchThreshold === null ? undefined : parseGenericValueComparison(totalMatchThreshold);

            // since we are dealing with user input (regex) it's likely they mess up their expression and end up matching *a lot* of stuff
            // so to keep memory under control only keep the first 100 matches
            // and just count the rest
            let matches: string[] = [];
            let matchCount = 0;
            let activitiesMatchedCount = 0;
            let activitiesTested = 0;
            let activityThresholdMet;
            let totalThresholdMet;

            // first lets see if the activity we are checking satisfies thresholds
            // since we may be able to avoid api calls to get history
            let actMatches = this.getMatchesFromActivity(item, testOn, reg, regexFlags);
            matches = matches.concat(actMatches).slice(0, 100);
            matchCount += actMatches.length;

            activitiesTested++;
            const singleMatched = comparisonTextOp(actMatches.length, matchComparison.operator, matchComparison.value);
            if (singleMatched) {
                activitiesMatchedCount++;
            }
            if (activityMatchComparison !== undefined) {
                activityThresholdMet = !activityMatchComparison.isPercent && comparisonTextOp(activitiesMatchedCount, activityMatchComparison.operator, activityMatchComparison.value);
            }
            if (totalMatchComparison !== undefined) {
                totalThresholdMet = comparisonTextOp(matchCount, totalMatchComparison.operator, totalMatchComparison.value);
            }

            let history: (Submission | Comment)[] = [];
            if ((activityThresholdMet === false || totalThresholdMet === false) && window !== undefined) {
                // our checking activity didn't meet threshold requirements and criteria does define window
                // leh go

                switch (lookAt) {
                    case 'all':
                        history = await this.resources.getAuthorActivities(item.author, {window: window});
                        break;
                    case 'submissions':
                        history = await this.resources.getAuthorSubmissions(item.author, {window: window});
                        break;
                    case 'comments':
                        history = await this.resources.getAuthorComments(item.author, {window: window});
                }
                // remove current activity it exists in history so we don't count it twice
                history = history.filter(x => x.id !== item.id);
                const historyLength = history.length;

                let activityCountFunc: Function | undefined;
                if (activityMatchComparison !== undefined) {
                    if (activityMatchComparison.isPercent) {
                        activityCountFunc = (actsMatched: number) => {
                            return comparisonTextOp(actsMatched / historyLength, activityMatchComparison.operator, activityMatchComparison.value / 100);
                        }
                    } else {
                        activityCountFunc = (actsMatched: number) => {
                            return comparisonTextOp(actsMatched, activityMatchComparison.operator, activityMatchComparison.value);
                        }
                    }
                }

                for (const h of history) {
                    activitiesTested++;
                    const aMatches = this.getMatchesFromActivity(h, testOn, reg, regexFlags);
                    matches = matches.concat(aMatches).slice(0, 100);
                    matchCount += aMatches.length;
                    const matched = comparisonTextOp(aMatches.length, matchComparison.operator, matchComparison.value);
                    if (matched) {
                        activitiesMatchedCount++;
                    }
                    if (activityCountFunc !== undefined && activityThresholdMet !== true && activityCountFunc(activitiesMatchedCount)) {
                        activityThresholdMet = true;
                    }
                    if (totalMatchComparison !== undefined && totalThresholdMet !== true) {
                        totalThresholdMet = comparisonTextOp(matchCount, totalMatchComparison.operator, totalMatchComparison.value)
                    }
                }
            }

            let humanWindow = '';
            if (history.length > 0) {
                if (typeof window === 'number') {
                    humanWindow = `${history.length} Items`;
                } else {
                    const firstActivity = history[0];
                    const lastActivity = history[history.length - 1];

                    humanWindow = dayjs.duration(dayjs(firstActivity.created_utc * 1000).diff(dayjs(lastActivity.created_utc * 1000))).humanize();
                }
            } else {
                humanWindow = '1 Item';
            }

            const critResults = {
                criteria: {
                    name,
                    regex,
                    testOn,
                    matchThreshold,
                    activityMatchThreshold,
                    totalMatchThreshold,
                    window: humanWindow
                },
                matches,
                matchCount,
                activitiesMatchedCount,
                activityThresholdMet,
                totalThresholdMet,
                triggered: false,
            };

            if (activityThresholdMet === undefined && totalThresholdMet === undefined) {
                // user should not have disabled both but in this scenario we'll pretend activityThresholdMet = singleMatch
                critResults.activityThresholdMet = singleMatched;
                critResults.triggered = singleMatched;
            } else {
                critResults.triggered = activityThresholdMet === true || totalThresholdMet === true;
            }

            criteriaResults.push(critResults);

            if (this.condition === 'OR') {
                if (critResults.triggered) {
                    break;
                }
            } else if (!critResults.triggered) {
                // since its AND and didn't match the whole rule will fail
                break;
            }
        }

        const criteriaMet = this.condition === 'OR' ? criteriaResults.some(x => x.triggered) : criteriaResults.every(x => x.triggered);

        const logSummary: string[] = [];
        let index = 0;
        for (const c of criteriaResults) {
            index++;
            let msg = `Crit ${c.criteria.name || index} ${c.triggered ? PASS : FAIL}`;
            if (c.activityThresholdMet !== undefined) {
                msg = `${msg} -- Activity Match=> ${c.activityThresholdMet ? PASS : FAIL} ${c.activitiesMatchedCount} ${c.criteria.activityMatchThreshold} (Threshold ${c.criteria.matchThreshold})`;
            }
            if (c.totalThresholdMet !== undefined) {
                msg = `${msg} -- Total Matches=> ${c.totalThresholdMet ? PASS : FAIL} ${c.matchCount} ${c.criteria.totalMatchThreshold}`;
            } else {
                msg = `${msg} and ${c.matchCount} Total Matches`;
            }
            msg = `${msg} (Window: ${c.criteria.window})`;
            logSummary.push(msg);
        }

        const result = `${criteriaMet ? PASS : FAIL} ${logSummary.join(' || ')}`;
        this.logger.verbose(result);

        return Promise.resolve([criteriaMet, this.getResult(criteriaMet, {result, data: criteriaResults})]);
    }

    protected getMatchesFromActivity(a: (Submission | Comment), testOn: string[], reg: RegExp, flags?: string): string[] {
        let m: string[] = [];
        // determine what content we are testing
        let contents: string[] = [];
        if (a instanceof Submission) {
            for (const l of testOn) {
                switch (l) {
                    case 'title':
                        contents.push(a.title);
                        break;
                    case 'body':
                        if (a.is_self) {
                            contents.push(a.selftext);
                        }
                        break;
                    case 'url':
                        if (isExternalUrlSubmission(a)) {
                            contents.push(a.url);
                        }
                        break;
                }
            }
        } else {
            contents.push(a.body)
        }

        for (const c of contents) {
            const results = parseRegex(reg, c, flags);
            if (results.matched) {
                m = m.concat(results.matches);
            }
        }
        return m;
    }
}

interface RegexConfig {
    /**
     * A list of Regular Expressions and conditions under which tested Activity(ies) are matched
     * @minItems 1
     * @examples [{"regex": "/reddit/", "matchThreshold": "> 3"}]
     * */
    criteria: RegexCriteria[]
    /**
     * * If `OR` then any set of Criteria that pass will trigger the Rule
     * * If `AND` then all Criteria sets must pass to trigger the Rule
     *
     * @default "OR"
     * */
    condition?: 'AND' | 'OR'
}

export interface RegexRuleOptions extends RegexConfig, RuleOptions {
}

/**
 * Test a (list of) Regular Expression against the contents or title of an Activity
 *
 * Optionally, specify a `window` of the User's history to additionally test against
 *
 * Available data for [Action templating](https://github.com/FoxxMD/reddit-context-bot#action-templating):
 *
 * */
export interface RegexRuleJSONConfig extends RegexConfig, RuleJSONConfig {
    /**
     * @examples ["regex"]
     * */
    kind: 'regex'
}

export default RegexRule;