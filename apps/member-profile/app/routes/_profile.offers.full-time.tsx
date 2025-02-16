import {
  json,
  type LoaderFunctionArgs,
  type SerializeFrom,
} from '@remix-run/node';
import {
  generatePath,
  Outlet,
  useLoaderData,
  useSearchParams,
} from '@remix-run/react';
import { DollarSign, MapPin } from 'react-feather';

import { track } from '@oyster/core/mixpanel';
import { db } from '@oyster/db';
import { Pagination, Table, type TableColumnProps, Text } from '@oyster/ui';
import {
  ClearFiltersButton,
  FilterButton,
  FilterEmptyMessage,
  FilterItem,
  FilterPopover,
  FilterRoot,
  FilterSearch,
  type FilterValue,
  useFilterContext,
} from '@oyster/ui/filter';

import { CompanyColumn, CompanyFilter } from '@/shared/components';
import { Route } from '@/shared/constants';
import { ensureUserAuthenticated, user } from '@/shared/session.server';

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await ensureUserAuthenticated(request);

  const { pathname, searchParams } = new URL(request.url);
  const {
    company,
    limit: _limit,
    page: _page,
    totalCompensation,
  } = Object.fromEntries(searchParams);

  const limit = parseInt(_limit) || 50;
  const page = parseInt(_page) || 1;

  const [appliedCompany, allCompanies, allLocations, { offers, totalOffers }] =
    await Promise.all([
      getAppliedCompany(company),
      listAllCompanies(),
      listAllLocations(),
      listFullTimeOffers({
        company,
        limit,
        locations: searchParams.getAll('location'),
        page,
        totalCompensation,
      }),
    ]);

  if (pathname === Route['/offers/full-time']) {
    track({
      event: 'Page Viewed',
      properties: { Page: 'Compensation' },
      request,
      user: user(session),
    });
  }

  return json({
    allCompanies,
    allLocations,
    appliedCompany,
    limit,
    offers,
    page,
    totalOffers,
  });
}

async function getAppliedCompany(companyFromSearch: string | null) {
  if (!companyFromSearch) {
    return undefined;
  }

  const company = await db
    .selectFrom('companies')
    .select(['id', 'name', 'imageUrl'])
    .where((eb) => {
      return eb.or([
        eb('companies.id', '=', companyFromSearch),
        eb('companies.name', 'ilike', companyFromSearch),
      ]);
    })
    .executeTakeFirst();

  return company;
}

async function listAllCompanies() {
  const companies = await db
    .selectFrom('companies')
    .select(['id', 'name', 'imageUrl'])
    .where((eb) => {
      return eb.exists(() => {
        return eb
          .selectFrom('fullTimeJobOffers as fullTimeOffers')
          .whereRef('fullTimeOffers.companyId', '=', 'companies.id');
      });
    })
    .orderBy('name', 'asc')
    .execute();

  return companies;
}

async function listAllLocations() {
  const rows = await db
    .selectFrom('fullTimeJobOffers')
    .select('location')
    .distinct()
    .where('location', 'is not', null)
    .orderBy('location', 'asc')
    .execute();

  const locations = rows.map((row) => {
    return row.location;
  });

  return locations;
}

type ListFullTimeOffersInput = {
  company: string | null;
  limit: number;
  locations: string[];
  page: number;
  totalCompensation: string | null;
};

async function listFullTimeOffers({
  company,
  limit,
  locations,
  page,
  totalCompensation,
}: ListFullTimeOffersInput) {
  const query = db
    .selectFrom('fullTimeJobOffers as fullTimeOffers')
    .leftJoin('companies', 'companies.id', 'fullTimeOffers.companyId')
    .$if(!!company, (qb) => {
      return qb.where((eb) => {
        return eb.or([
          eb('companies.id', '=', company),
          eb('companies.name', 'ilike', company),
        ]);
      });
    })
    .$if(locations.length > 0, (qb) => {
      return qb.where('fullTimeOffers.location', 'in', locations);
    })
    .$if(!!totalCompensation, (qb) => {
      return qb.where(
        'fullTimeOffers.totalCompensation',
        '>=',
        totalCompensation
      );
    });

  const [{ count }, _offers] = await Promise.all([
    query
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow(),

    query
      .select([
        'companies.id as companyId',
        'companies.name as companyName',
        'companies.imageUrl as companyLogo',
        'fullTimeOffers.baseSalary',
        'fullTimeOffers.id',
        'fullTimeOffers.location',
        'fullTimeOffers.performanceBonus',
        'fullTimeOffers.role',
        'fullTimeOffers.signOnBonus',
        'fullTimeOffers.totalCompensation',
        'fullTimeOffers.totalStock',
      ])
      .orderBy('fullTimeOffers.postedAt', 'desc')
      .limit(limit)
      .offset((page - 1) * limit)
      .execute(),
  ]);

  const formatter = new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 0,
    style: 'currency',
  });

  const offers = _offers.map((offer) => {
    const annualBonus =
      (Number(offer.performanceBonus) || 0) +
      (Number(offer.signOnBonus) || 0) / 4;

    return {
      ...offer,
      annualBonus: formatter.format(annualBonus),
      annualStock: formatter.format((Number(offer.totalStock) || 0) / 4),
      baseSalary: formatter.format(Number(offer.baseSalary)),
      totalCompensation: formatter.format(Number(offer.totalCompensation)),
    };
  });

  return {
    offers,
    totalOffers: Number(count),
  };
}

// Page

export default function FullTimeOffersPage() {
  const { allCompanies, appliedCompany } = useLoaderData<typeof loader>();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <CompanyFilter
            allCompanies={allCompanies}
            emptyMessage="No companies found that are linked to full-time offers."
            selectedCompany={appliedCompany}
          />
          <TotalCompensationFilter />
          <LocationFilter />
        </div>

        <ClearFiltersButton />
      </div>

      <FullTimeOffersTable />
      <FullTimeOffersPagination />
      <Outlet />
    </>
  );
}

// Table

type FullTimeOfferInView = SerializeFrom<typeof loader>['offers'][number];

function FullTimeOffersTable() {
  const { offers } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const columns: TableColumnProps<FullTimeOfferInView>[] = [
    {
      displayName: 'Company',
      size: '200',
      render: (offer) => <CompanyColumn {...offer} />,
    },
    {
      displayName: 'Role',
      size: '240',
      render: (offer) => offer.role,
    },
    {
      displayName: 'Total Compensation',
      size: '160',
      render: (offer) => {
        return (
          <Text
            as="span"
            className="rounded-md bg-yellow-50 px-2 py-1"
            weight="500"
          >
            {offer.totalCompensation}
          </Text>
        );
      },
    },
    {
      displayName: 'Base Salary',
      size: '120',
      render: (offer) => offer.baseSalary,
    },
    {
      displayName: 'Stock (/yr)',
      size: '120',
      render: (offer) => offer.annualStock,
    },
    {
      displayName: 'Bonus (/yr)',
      size: '160',
      render: (offer) => offer.annualBonus,
    },
    {
      displayName: 'Location',
      size: '200',
      render: (offer) => offer.location,
    },
  ];

  return (
    <Table
      columns={columns}
      data={offers}
      emptyMessage="No full-time offers found matching the criteria."
      rowTo={({ id }) => {
        return {
          pathname: generatePath(Route['/offers/full-time/:id'], { id }),
          search: searchParams.toString(),
        };
      }}
    />
  );
}

function FullTimeOffersPagination() {
  const { limit, offers, page, totalOffers } = useLoaderData<typeof loader>();

  return (
    <Pagination
      dataLength={offers.length}
      page={page}
      pageSize={limit}
      totalCount={totalOffers}
    />
  );
}

// Filters

function TotalCompensationFilter() {
  const [searchParams] = useSearchParams();

  const totalCompensation = searchParams.get('totalCompensation');

  const options: FilterValue[] = [
    { color: 'red-100', label: '> $100K', value: '100000' },
    { color: 'orange-100', label: '> $125K', value: '125000' },
    { color: 'amber-100', label: '> $150K', value: '150000' },
    { color: 'cyan-100', label: '> $175K', value: '175000' },
    { color: 'green-100', label: '> $200K', value: '200000' },
    { color: 'lime-100', label: '> $250K', value: '250000' },
    { color: 'pink-100', label: '> $300K', value: '300000' },
    { color: 'purple-100', label: '> $350K', value: '350000' },
  ];

  const selectedValues = options.filter((option) => {
    return totalCompensation === option.value;
  });

  return (
    <FilterRoot>
      <FilterButton
        icon={<DollarSign />}
        popover
        selectedValues={selectedValues}
      >
        Total Compensation
      </FilterButton>

      <FilterPopover>
        <ul className="overflow-auto">
          {options.map((option) => {
            return (
              <FilterItem
                checked={totalCompensation === option.value}
                color={option.color}
                key={option.value}
                label={option.label}
                name="totalCompensation"
                value={option.value}
              />
            );
          })}
        </ul>
      </FilterPopover>
    </FilterRoot>
  );
}

function LocationFilter() {
  const [searchParams] = useSearchParams();

  const locations = searchParams.getAll('location');

  return (
    <FilterRoot multiple>
      <FilterButton
        icon={<MapPin />}
        popover
        selectedValues={locations.map((location) => {
          return {
            color: 'purple-100',
            label: location,
            value: location,
          };
        })}
      >
        Location
      </FilterButton>

      <FilterPopover>
        <FilterSearch />
        <LocationList />
      </FilterPopover>
    </FilterRoot>
  );
}

function LocationList() {
  const [searchParams] = useSearchParams();
  const { allLocations } = useLoaderData<typeof loader>();
  const { search } = useFilterContext();

  let filteredLocations = allLocations;

  if (search) {
    filteredLocations = allLocations.filter((location) => {
      return new RegExp(search, 'i').test(location);
    });
  }

  if (!filteredLocations.length) {
    return <FilterEmptyMessage>No locations found.</FilterEmptyMessage>;
  }

  const selectedLocations = searchParams.getAll('location');

  return (
    <ul className="overflow-auto">
      {filteredLocations.map((location) => {
        return (
          <FilterItem
            checked={selectedLocations.includes(location)}
            key={location}
            label={location}
            name="location"
            value={location}
          />
        );
      })}
    </ul>
  );
}
